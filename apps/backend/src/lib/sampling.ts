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
 * Ceiling on a turn that may have to emit a whole FILE.
 *
 * ── WHY THE 800 ABOVE IS NOT ENOUGH ──
 * That number is right for a dispatch turn whose tool call is a shell line. It is wrong whenever
 * `write_file` is on the table, because there the argument IS the file: the model must emit the
 * entire contents, JSON-escaped, inside one tool call.
 *
 * Measured. Asked for a GitHub client with auth headers, Link-header pagination and error mapping —
 * comfortably 1,500+ tokens of JavaScript — the model said "Let me create both files now." and
 * emitted nothing, three turns running, until the loop gave up. It had begun the tool call, hit the
 * ceiling mid-argument, and the truncated call was discarded. From outside it looked like a model
 * that had stopped trying; it was a model that could not physically finish a sentence.
 *
 * So the cap has to fit the largest thing the agent is ALLOWED to produce, which is a source file.
 *
 * 8,000 rather than 4,000 because 4,000 was still not enough and failed IDENTICALLY: a turn came
 * back with `finish_reason: "tool_calls"` and `completion_tokens: 3997`, dead on the ceiling, the
 * call cut off mid-argument and discarded. A 9 KB source file is roughly 3,000 tokens before the
 * JSON escaping and the prose the model writes first. With a 32K context this still leaves ample
 * room for the conversation.
 */
export const FILE_TURN_MAX_TOKENS = 8000;

/**
 * The ceiling for one turn, given what the agent may do in it.
 *
 * One function rather than three constants read at the call site: the rule is "large enough for the
 * biggest legitimate output", and that is a property of the toolset, not of the caller.
 */
export function turnMaxTokens(opts: { think?: boolean; canWriteFiles?: boolean }): number {
  if (opts.canWriteFiles) return Math.max(FILE_TURN_MAX_TOKENS, opts.think ? THINKING_TURN_MAX_TOKENS : 0);
  return opts.think ? THINKING_TURN_MAX_TOKENS : TOOL_TURN_MAX_TOKENS;
}

/**
 * What to assume when the model did not say.
 *
 * ── RENAMED FROM `ASSUMED_CONTEXT_TOKENS`, BECAUSE IT WAS BEING READ AS A FACT ──
 * It was the only source of truth for every budget in the harness, and it was wrong by 4x. The
 * deployed model reports `max_seq_len: 131072` and the platform already stored that on the
 * deployment record as `tabbyMaxSeqLen`; nothing read it. So a leaf whose prompt reached 29,450
 * tokens was handed `32768 - 29450 - 512` = 2,806 generation tokens, with 101,110 actually free —
 * on a Synthesist whose deliverable is a long markdown document.
 *
 * The old comment was right that asking the endpoint per turn is a wasteful round trip. The mistake
 * was concluding that a constant is the alternative: the value is recorded at deploy time, and the
 * catalogue (`llm-apps.ts`) names the field per engine.
 *
 * This remains for the case nobody records — a registered OpenAI-compatible endpoint. Conservative
 * on purpose: too small wastes room, too large fails the request outright before a token is
 * generated.
 */
export const FALLBACK_CONTEXT_TOKENS = 32_768;

/** Room left for the engine's own framing after the prompt and the reply. */
const CONTEXT_MARGIN_TOKENS = 512;

/** Below this a turn cannot say anything useful, so failing loudly beats a truncated reply. */
export const MIN_TURN_TOKENS = 600;

/**
 * A reply budget that fits in what is left of the window.
 *
 * ── WHY A CEILING IS NOT ENOUGH ──
 * The engine allocates PROMPT + max_tokens up front and refuses the request if the pair does not
 * fit. So a generous ceiling is not merely wasteful when the prompt is large — it is fatal, and it
 * fails before a single token is generated.
 *
 * Measured, and self-inflicted: raising the file-writing ceiling to 8,000 made large writes
 * possible and then killed a leaf whose prompt had grown to roughly 26,800 tokens —
 * `requires 34816 cache tokens, which exceeds the available context size of 32768`. 26,816 + 8,000
 * is exactly 34,816. The ceiling was right; asking for it unconditionally was not.
 *
 * Characters over four is the usual rough conversion. It does not need to be exact — it needs to
 * be conservative, and the margin covers the error.
 */
export function fittedMaxTokens(ceiling: number, promptChars: number, contextTokens = FALLBACK_CONTEXT_TOKENS): number {
  const promptTokens = Math.ceil(promptChars / 4);
  const available = contextTokens - promptTokens - CONTEXT_MARGIN_TOKENS;
  return Math.max(MIN_TURN_TOKENS, Math.min(ceiling, available));
}

/**
 * How much of the window a prompt has already eaten, as a fraction.
 *
 * ── WHY THIS EXISTS NEXT TO fittedMaxTokens AND NOT SOMEWHERE ELSE ──
 * `fittedMaxTokens` FLOORS at MIN_TURN_TOKENS, which is the right behaviour for a reply budget and
 * a terrible signal for a caller. Once `available` goes below the floor the function returns 600
 * no matter how far past the window the prompt is, so the number stops moving exactly when the
 * trouble starts — and the caller asks the engine for prompt + 600 against a window the prompt
 * alone already exceeds. The engine allocates both up front and refuses, before a token is
 * generated. There is no recovering from that mid-turn; it has to be seen coming.
 *
 * So this reports the raw pressure, unfloored and uncapped, and the two live side by side because
 * they must agree about the window they are given and about the margin. They drifted once already
 * in the sense that nothing was watching the number at all.
 *
 * Returns >1 when the prompt does not fit at all. Callers decide what to do about it — see
 * lib/koala-context.ts, which resets the conversation well before this reaches 1.
 */
export function contextPressure(promptChars: number, contextTokens = FALLBACK_CONTEXT_TOKENS): number {
  const promptTokens = Math.ceil(promptChars / 4);
  return (promptTokens + CONTEXT_MARGIN_TOKENS) / contextTokens;
}

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
