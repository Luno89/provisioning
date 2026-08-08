/**
 * Sampler settings that stop a reasoning model looping on itself.
 *
 * ── THE FAILURE THIS EXISTS FOR ──
 * Observed live: a model produced roughly forty consecutive lines of "(Wait, I'll output)" while
 * deliberating about whether to emit a tool call, never emitted one, and consumed its entire
 * completion budget. The turn then looks to the caller like a model that answered in prose.
 *
 * Three distinct causes, and only one of them is the model's judgement:
 *
 *  1. Formatting anxiety, when tool calls are text the model must format itself. Fixed by using
 *     native tool calling — the engine emits the structure and there is nothing to agonise over.
 *     Not this file's job, but it is the largest of the three.
 *  2. Reasoning spent on a decision that does not benefit from it. Fixed by NO_THINKING below.
 *  3. Degenerate repetition, which is a DECODING failure. Fixed by the penalties below.
 *
 * ── WHY THIS IS SPLIT BY ENGINE ──
 * The platform talks to any OpenAI-compatible endpoint, including OpenAI itself and whatever a
 * user registers over the mesh. `frequency_penalty` is part of that API and is safe to send
 * anywhere. DRY is not — it is an exllama/TabbyAPI sampler, and a strict server is entitled to
 * reject an unknown field with a 400, which would turn a loop-prevention measure into an outage
 * for every user on a different engine. So engine-specific settings go out only when the platform
 * deployed the engine and therefore knows what it is.
 */
import type { ModelKind } from './model-registry.js';

/**
 * Turns off the reasoning pass for one request.
 *
 * Measured against the live TabbyAPI deployment serving Qwen3: structured output went from about
 * one reply in eight to three out of three with this set. Reasoning talks the model out of the
 * format — it is not that the model cannot do it.
 *
 * Must be nested under `template_vars`. Sent at the top level it is silently ignored and the model
 * produces garbage — confirmed, it emitted Chinese mid-sentence.
 */
export const NO_THINKING = { template_vars: { enable_thinking: false } } as const;

/** Standard OpenAI-API penalties. Safe to send to any endpoint. */
const PORTABLE_LOOP_GUARD = {
  // Frequency & presence penalties prevent local open-weight models from entering synonym/word repetition loops.
  frequency_penalty: 0.4,
  presence_penalty: 0.3,
} as const;

/**
 * DRY ("Don't Repeat Yourself") — penalises repeating an n-gram that has already appeared.
 *
 * The right tool for this specific failure: it targets repeated SEQUENCES rather than repeated
 * tokens, so it cuts "(Wait, I'll output)" on the second occurrence while leaving legitimately
 * repetitive code alone.
 */
const TABBY_LOOP_GUARD = {
  dry_multiplier: 0.8,
  dry_base: 1.75,
  dry_allowed_length: 2,
} as const;

/**
 * Sampler settings for a turn whose job is to CALL A TOOL rather than to talk.
 *
 * Lower temperature because picking the right tool is not a creative act — and a model sampling
 * adventurously among tool names is how a leaf ends up revised when it should have been withdrawn.
 */
export function toolTurnSampling(kind?: ModelKind): Record<string, unknown> {
  return {
    temperature: 0.3,
    /**
     * NO frequency or presence penalty on a turn that has to call a tool.
     *
     * ── MEASURED, NOT REASONED ──
     * `frequency_penalty: 0.4` + `presence_penalty: 0.3` do not degrade tool calling on this
     * harness, they eliminate it. A 24-run experiment (exp-penalties-001, two hidden-spec tasks,
     * three repeats, two prompts) scored 0/12 with the penalties and 12/12 without — perfect
     * separation on both tasks. The failing runs burned all 40 steps in five seconds having made
     * ZERO tool calls: the loop spins through its whole budget because the agent cannot emit a
     * call at all.
     *
     * The mechanism is plain once seen. Emitting a tool call means reproducing function names and
     * JSON keys that already appear in the prompt, and these penalties push the model away from
     * exactly those tokens. More tools makes it worse — the 14-tool planner never called anything,
     * while the 3-tool agent loop managed 1 in 3.
     *
     * ── WHAT IS LOST ──
     * The guard was added for a real pathology: forty identical lines of output. DRY still covers
     * that on TabbyAPI and is innocent here (3/3 tool calls with DRY alone). On an engine with no
     * DRY support a tool turn now has no repetition guard — accepted deliberately, because a turn
     * that cannot call a tool is worthless whether or not it repeats itself, and the loop's step
     * cap bounds the damage.
     *
     * Measured on TabbyAPI serving Qwen3. The mechanism is general to how these penalties work,
     * but only one engine was tested.
     */
    ...(kind === 'tabbyapi' ? TABBY_LOOP_GUARD : {}),
  };
}

/**
 * Loop guards for a turn that SHOULD still think — the planning conversation.
 *
 * Reasoning stays on here by explicit decision: it is what makes the chat worth talking to. Only
 * the decoding pathology is suppressed, and the temperature is left to the caller.
 */
export function conversationSampling(kind?: ModelKind): Record<string, unknown> {
  return {
    ...PORTABLE_LOOP_GUARD,
    ...(kind === 'tabbyapi' ? TABBY_LOOP_GUARD : {}),
  };
}

/**
 * Ceiling on ONE tool-dispatch turn.
 *
 * Deliberately far below the conversational budget. A dispatch turn that has not produced a tool
 * call in this many tokens is looping, and the cheapest way out is to stop paying for it — the
 * agent loop treats a turn with no tool call as a prompt to try again, so the recovery already
 * exists.
 */
export const TOOL_TURN_MAX_TOKENS = 800;

/**
 * Ceiling on a dispatch turn that is ALLOWED to reason.
 *
 * Higher because the reasoning pass consumes the budget before the answer starts — the failure
 * documented for plan mode, where a turn produced 7,908 characters of deliberation before 1,210 of
 * reply. It lived inline in the agent loop as a bare `2000`, which meant the tunable registry
 * advertised 800 as the token ceiling while half of all runs used something else.
 */
export const THINKING_TURN_MAX_TOKENS = 2000;

/**
 * Told to any model that has tools.
 *
 * Addresses a specific observed failure: the model wrote a plausible `list_projects` RESULT into
 * its own reasoning, believed it, and then spent the rest of the turn discovering it had invented
 * the data. Stating that results are provided — and that stopping is the correct move — removes
 * the reason to imagine one.
 */
export const TOOL_DISCIPLINE_PROMPT = [
  'Never invent, predict, or write out a tool result. If you need data, call the tool and stop —',
  'the result will be given to you in the next turn. Do not deliberate about output formatting;',
  'call the tool directly.',
].join('\n');
