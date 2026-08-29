/**
 * Every knob that changes how the model is called — declared once, in one place.
 *
 * ── WHY A REGISTRY AND NOT AN INTERFACE ──
 * This started as a hand-written `ExperimentOverrides` interface with five fields, each of which
 * had to be separately threaded into the request body. That arrangement has exactly one failure
 * mode and it is silent: `temperature` sat in the interface, in the tunable list, and in the UI's
 * axis picker for the whole of its first life while never being sent — so an experiment varying it
 * ran two byte-identical configurations and reported the noise between them as an effect.
 *
 * A declaration cannot half-exist that way. Each entry states its own wire field, where in the
 * request it belongs, and which engines will accept it, and `applyOverrides` is the only thing that
 * writes any of them into a body. Adding a knob is one entry here rather than five edits across
 * three files, and `tunables.test.ts` asserts that every registered key reaches the wire — which is
 * the generalisation of the bug that motivated the whole file.
 *
 * ── DEFAULTS ARE READ, NEVER RESTATED ──
 * `default` on each entry comes from the constant the running code uses. A hand-copied default here
 * would be worse than none: an experiment's control arm would silently differ from what the harness
 * actually does, and every comparison drawn against it would be wrong in a way nothing reports.
 */
import type { ModelKind } from './model-registry.js';
import { toolTurnSampling, TOOL_TURN_MAX_TOKENS, THINKING_TURN_MAX_TOKENS } from './sampling.js';
import { MAX_AGENT_TOKENS, MAX_AGENT_STEPS, MAX_TOOL_RESULT_CHARS } from './sandbox-tools.js';
import type { EffectiveKnob, Overrides, Tunable, TunablePlacement, TunableType } from '@koala/harness-types';

/** Re-exported: the Lab builds its axis picker from these, so both sides read one declaration. */
export type { EffectiveKnob, Overrides, Tunable, TunablePlacement, TunableType };

const dispatchDefaults = toolTurnSampling(undefined);
const tabbyDefaults = toolTurnSampling('tabbyapi');

export const TUNABLES: Tunable[] = [
  // ── sampling: portable across every OpenAI-compatible engine ──
  {
    key: 'temperature',
    label: 'Temperature',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    min: 0,
    max: 2,
    step: 0.05,
    default: dispatchDefaults.temperature,
    suggested: [0.2, 0.7],
    note: 'Low by default because choosing a tool is not a creative act, and a model sampling '
      + 'adventurously among tool names is how a leaf gets revised when it should have been withdrawn.',
    source: 'lib/sampling.ts',
  },
  {
    key: 'top_p',
    label: 'Top-p',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    min: 0,
    max: 1,
    step: 0.05,
    // Unset by default: the engine's own default applies, and pinning it here would be a second
    // opinion about a value nobody has measured on this harness.
    default: undefined,
    suggested: [0.8, 1],
    note: 'Nucleus sampling: keeps the smallest set of tokens whose probabilities add up to this, '
      + 'and samples from those. Overlaps with temperature — turning both down compounds, and '
      + 'is a common way to make a model repeat itself.',
    source: 'lib/tunables.ts',
  },
  {
    key: 'frequency_penalty',
    label: 'Frequency penalty',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    min: -2,
    max: 2,
    step: 0.1,
    default: dispatchDefaults.frequency_penalty,
    suggested: [0, 0.3],
    note: 'Enough to make a second identical line expensive, low enough not to distort code, where '
      + 'real repetition is normal and correct.',
    source: 'lib/sampling.ts',
  },
  {
    key: 'presence_penalty',
    label: 'Presence penalty',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    min: -2,
    max: 2,
    step: 0.1,
    default: undefined,
    suggested: [0, 0.5],
    note: 'A flat penalty for any token that has already appeared, however many times. '
      + 'Frequency penalty scales with the count; this one does not, so it pushes toward new '
      + 'subject matter rather than away from repetition.',
    source: 'lib/tunables.ts',
  },
  {
    key: 'seed',
    label: 'Seed',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    default: undefined,
    note: 'Pin it to make repeats measure the harness rather than sampling noise — and leave it off '
      + 'when the variance IS what you are measuring.',
    source: 'lib/tunables.ts',
  },
  {
    key: 'max_tokens',
    label: 'Tokens per dispatch turn',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    min: 64,
    max: 8192,
    step: 64,
    default: TOOL_TURN_MAX_TOKENS,
    suggested: [TOOL_TURN_MAX_TOKENS, THINKING_TURN_MAX_TOKENS],
    note: 'A dispatch turn that has not produced a tool call by here is looping, and the cheapest '
      + `way out is to stop paying for it. Rises to ${THINKING_TURN_MAX_TOKENS} when reasoning is `
      + 'on, because the reasoning pass spends the budget before the answer starts.',
    source: 'lib/sampling.ts',
  },

  // ── sampling: TabbyAPI only ──
  {
    key: 'top_k',
    label: 'Top-k',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    engine: 'tabbyapi',
    min: 0,
    max: 200,
    step: 1,
    default: undefined,
    suggested: [0, 40],
    note: 'Keeps only the k most likely tokens at each step. 0 disables it. Blunter than min-p: a '
      + 'fixed cut regardless of how confident the model is at that point.',
    source: 'lib/tunables.ts',
  },
  {
    key: 'min_p',
    label: 'Min-p',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    engine: 'tabbyapi',
    min: 0,
    max: 1,
    step: 0.01,
    default: undefined,
    suggested: [0, 0.05],
    note: 'Drops tokens below this fraction of the most likely one. Adapts with confidence — where '
      + 'top-k always keeps k, this keeps many when the model is unsure and few when it is not.',
    source: 'lib/tunables.ts',
  },
  {
    key: 'repetition_penalty',
    label: 'Repetition penalty',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    engine: 'tabbyapi',
    min: 1,
    max: 2,
    step: 0.01,
    default: undefined,
    suggested: [1, 1.1],
    note: 'Divides the score of any token already in the context. Blunt: it applies to the '
      + 'whole context including code, where repetition is normal and correct. DRY targets '
      + 'repeated SEQUENCES instead, which is usually what you actually want here.',
    source: 'lib/tunables.ts',
  },
  {
    key: 'dry_multiplier',
    label: 'DRY multiplier',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    engine: 'tabbyapi',
    min: 0,
    max: 5,
    step: 0.1,
    default: tabbyDefaults.dry_multiplier,
    suggested: [0, 0.8],
    note: 'Penalises repeated SEQUENCES, so it cuts a repeating line without touching legitimately '
      + 'repetitive code. This is the sampler that exists for the forty-consecutive-"(Wait, I\'ll '
      + 'output)" failure.',
    source: 'lib/sampling.ts',
  },
  {
    key: 'dry_base',
    label: 'DRY base',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    engine: 'tabbyapi',
    min: 1,
    max: 4,
    step: 0.05,
    default: tabbyDefaults.dry_base,
    note: 'How steeply the DRY penalty grows as a repeated sequence gets longer. Higher makes a '
      + 'long repetition escalate faster; the multiplier sets the overall strength.',
    source: 'lib/sampling.ts',
  },
  {
    key: 'dry_allowed_length',
    label: 'DRY allowed length',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    engine: 'tabbyapi',
    min: 1,
    max: 20,
    step: 1,
    default: tabbyDefaults.dry_allowed_length,
    note: 'Sequence length that repeats for free before DRY starts penalising. Too low and it '
      + 'suppresses common code constructs like "return result;".',
    source: 'lib/sampling.ts',
  },
  {
    key: 'thoughtMonitorSensitivity',
    label: 'Thought Monitor Sensitivity',
    group: 'sampling',
    type: 'enum',
    placement: 'body',
    options: ['low', 'medium', 'high'],
    default: 'medium',
    suggested: ['low', 'medium', 'high'],
    note: 'Controls real-time sensitivity of the ML failure predictor when detecting reasoning stalls.',
    source: 'lib/thinking-classifier.ts',
  },
  {
    key: 'ngramRepeatThreshold',
    label: 'N-Gram Repeat Cap',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    min: 2,
    max: 10,
    step: 1,
    default: 3,
    suggested: [3, 5],
    note: 'Number of repeated n-gram sequences permitted before scoring an overthinking stall.',
    source: 'lib/thinking-classifier.ts',
  },
  {
    key: 'failurePredictionThreshold',
    label: 'Failure Prediction Cutoff',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    min: 0.5,
    max: 0.99,
    step: 0.05,
    default: 0.80,
    suggested: [0.75, 0.85],
    note: 'Probability cutoff (0.50 to 0.99) at which an overthinking trajectory is interrupted.',
    source: 'lib/thinking-classifier.ts',
  },

  // ── the reasoning switch ──
  {
    key: 'think',
    label: 'Reasoning on dispatch turns',
    group: 'sampling',
    type: 'boolean',
    // The one knob whose placement is load-bearing: nested it works, top-level it is ignored and
    // output degrades without any error.
    placement: 'template_vars',
    field: 'enable_thinking',
    default: false,
    suggested: [false, true],
    note: 'Off by default. Measured: with reasoning on, a dispatch turn can spend its whole budget '
      + 'deliberating, emit no tool call at all, and read to the loop as a model that answered in prose.',
    source: 'lib/sampling.ts',
  },

  // ── loop controls: consumed here, never sent ──
  {
    key: 'useMemories',
    label: 'Inject Harness Memory Bank',
    group: 'loop',
    type: 'boolean',
    placement: 'loop',
    default: true,
    suggested: [true, false],
    note: 'When enabled, active lessons, environment facts, and rules from the Memory Bank are injected into system context. Turn off to run a control arm without memory context in A/B experiments.',
    source: 'lib/memory-store.ts',
  },
  {
    key: 'memoryDecide',
    label: 'Decide what to remember',
    group: 'loop',
    type: 'boolean',
    placement: 'loop',
    default: true,
    suggested: [true, false],
    note: 'When enabled, a memory a leaf extracts is checked against the most similar entries already '
      + 'stored and the model decides whether it is new, refines one, contradicts one, or is already '
      + 'known. This replaced a human review queue that nobody drained — 124 of 143 memories sat in it '
      + 'unread. Turn off to admit everything unconditionally, which is what happens anyway whenever '
      + 'the model or the search stack is unreachable.',
    source: 'lib/memory-decide.ts',
  },
  {
    key: 'conversationGrowth',
    label: 'Conversation retention multiplier',
    group: 'loop',
    type: 'number',
    placement: 'loop',
    default: 2,
    min: 1,
    max: 4,
    suggested: [1, 2, 3, 4],
    note: 'How much more of its own conversation a run may keep than the 32k baseline allowed. The '
      + 'budget is a share of the model\'s real window, capped by this. 1 reproduces the old '
      + 'behaviour on any model; 4 is fully proportional. Held below proportional by default because '
      + 'prompt length changes every turn\'s cost and the effect of remembering four times as much '
      + 'is unmeasured — raise it here and compare, rather than assuming.',
    source: 'lib/sandbox-tools.ts',
  },
  {
    key: 'maxTokens',
    label: 'Max tokens',
    group: 'loop',
    type: 'number',
    placement: 'loop',
    min: 1_000,
    max: 5_000_000,
    step: 1_000,
    default: MAX_AGENT_TOKENS,
    suggested: [200_000, 1_000_000],
    note: 'What a run actually costs, and the bound that should normally stop one. Measured here, '
      + 'a coding run ranges 43k to 604k tokens with a median of 149k.',
    source: 'lib/agent-loop.ts',
  },
  {
    key: 'maxSteps',
    label: 'Max steps',
    group: 'loop',
    type: 'number',
    placement: 'loop',
    min: 1,
    // Was 64, below the shipped default of 200 — which made the default itself unsettable and any
    // attempt to raise it a validation error.
    max: 500,
    step: 1,
    default: MAX_AGENT_STEPS,
    suggested: [40, 100],
    note: 'A safety ceiling, not a working budget — a step can be 200 tokens or 20,000, so counting '
      + 'them bounds neither spend nor time. Use Max tokens for that. Running out of either earns a '
      + 'wrap-up turn rather than being recorded as a failure.',
    source: 'lib/sandbox-tools.ts',
  },
  {
    key: 'maxToolResultChars',
    label: 'Tool result cap',
    group: 'loop',
    type: 'number',
    placement: 'loop',
    min: 500,
    max: 32_000,
    step: 500,
    default: MAX_TOOL_RESULT_CHARS,
    suggested: [4000, 8000],
    note: 'Truncated from the FRONT, so exit codes and errors at the tail survive.',
    source: 'lib/sandbox-tools.ts',
  },
  {
    key: 'model',
    label: 'Model',
    group: 'loop',
    type: 'string',
    placement: 'loop',
    default: undefined,
    // The value is a PROVIDER id, not a model name — it selects which API to talk to, and the name
    // sent on the wire comes from that provider. Free text here only ever produced "not found".
    choicesFrom: 'models',
    /**
     * Not settable on the profile — see `settableAt`.
     *
     * `request` is kept because that is how the Lab compares two engines on one suite
     * (`ExperimentService` passes variant overrides as the request layer); `persona` because a
     * persona choosing its own model is the intended way to use several at once. What is refused is
     * the one field that repoints an entire project.
     */
    /**
     * `pack` is where this belongs now; `persona` remains during the move.
     *
     * Runtime configuration is migrating from the persona onto the pack — a persona is who, a pack
     * is how — and personas still carry an `overrides` bag until that migration lands. Both layers
     * are genuinely settable in the meantime, so both are listed; dropping `persona` early would
     * refuse an override that is still in force on existing records.
     */
    settableAt: ['persona', 'pack', 'request'],
    note: 'Which of your model APIs to run against — a deployed engine or a registered endpoint. '
      + 'Resolved to a base URL before the call, so two engines can be compared on the same suite.',
    source: 'services/ModelService.ts',
  },

  // ── the prompt itself ──
  {
    key: 'systemPrompt',
    label: 'System prompt (full replace)',
    group: 'prompt',
    type: 'string',
    placement: 'loop',
    // Undefined because there is no constant to point at: the prompt is built per task. `promptId`
    // names the generated one instead, so an editor can open on what is really being sent.
    default: undefined,
    promptId: 'agent',
    note: 'Replaces the generated prompt ENTIRELY, including the environment description — so a '
      + 'replacement that omits "there is no network" will have the agent plan around an `npm '
      + 'install` that cannot work. Prefer extra instructions unless the environment text is what '
      + 'you are testing.',
    source: 'lib/sandbox-tools.ts',
  },
  {
    key: 'extraInstructions',
    label: 'Extra instructions',
    group: 'prompt',
    type: 'string',
    placement: 'loop',
    default: undefined,
    note: 'Appended to the generated prompt. The safe way to test wording, since the environment '
      + 'description survives.',
    source: 'lib/sandbox-tools.ts',
  },
];

const BY_KEY = new Map(TUNABLES.map((t) => [t.key, t]));

export const tunable = (key: string): Tunable | undefined => BY_KEY.get(key);

/** Overrides as they travel: an open bag, validated against the registry rather than by its type. */

/** Keys the loop reads directly instead of sending. */
export const loopKeys = (): string[] =>
  TUNABLES.filter((t) => t.placement === 'loop').map((t) => t.key);

/**
 * Merges overrides into a request body.
 *
 * The ONLY thing that writes a tunable onto the wire. Everything else — the UI, validation, the
 * config page — describes; this is what makes a declaration real, which is why the test that every
 * key survives a round trip through here is the important one in the suite.
 *
 * Silently drops what it cannot send rather than throwing: an engine-gated sampler reaching a
 * different engine is a knob that does nothing, not a broken run, and failing the whole experiment
 * over it would discard the variants that were fine. `unsupported` reports what was dropped so the
 * caller can say so.
 */
export function applyOverrides(
  body: Record<string, unknown>,
  overrides: Overrides,
  kind?: ModelKind,
): { body: Record<string, unknown>; unsupported: string[] } {
  const next = { ...body };
  const unsupported: string[] = [];

  for (const [key, value] of Object.entries(overrides)) {
    // Both mean "nothing to send": undefined was never set, null asked for the built-in default.
    // `effectiveOverrides` already stripped a null it could act on, so one arriving here is a
    // caller with no profile to opt out of — which is simply the default, and nothing to write.
    if (value === undefined || value === null) continue;
    const spec = BY_KEY.get(key);
    if (!spec) {
      unsupported.push(key);
      continue;
    }
    if (spec.placement === 'loop') continue;
    if (spec.engine && spec.engine !== kind) {
      unsupported.push(key);
      continue;
    }

    const field = spec.field ?? spec.key;
    if (spec.placement === 'template_vars') {
      // Merged, not replaced: the harness already sends `enable_thinking` here and a bare
      // assignment would drop whatever else the caller had nested.
      const existing = (next.template_vars ?? {}) as Record<string, unknown>;
      next.template_vars = { ...existing, [field]: value };
    } else {
      next[field] = value;
    }
  }

  return { body: next, unsupported };
}

/** Rejects an override before it reaches a model call. */
export interface OverrideContext {
  /** Which layer is being written. Omitted means "not a layered write", and layer rules are skipped. */
  layer?: 'profile' | 'persona' | 'pack' | 'request';
  /**
   * The values a `choicesFrom` knob may take, resolved by the caller.
   *
   * Passed in rather than looked up: this module is pure and has no database, and the valid set is
   * per-tenant. Omitted means the caller could not resolve them, and the check is skipped rather
   * than refusing everything — a model list that failed to load must not make the form unusable.
   */
  models?: string[];
}

/** "a", "a or b", "a, b or c" — a refusal naming three layers should still read as a sentence. */
const orList = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;

export function validateOverrides(overrides: Overrides, context: OverrideContext = {}): string | null {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const spec = BY_KEY.get(key);
    if (!spec) return `Unknown setting "${key}".`;
    /**
     * `null` is the opt-out, not a value.
     *
     * It means "ignore whatever the promoted profile supplies for this key and use the harness's
     * built-in default" — the only way to express a control arm once anything has been adopted.
     * Type-checking it as a value rejected exactly the variant that needed it most, which is how a
     * control arm ended up impossible to write.
     */
    if (value === null) continue;

    /**
     * Which layer may set this at all.
     *
     * Refused here rather than ignored at resolve time: a setting that is silently dropped is worse
     * than one that is refused, because the person who set it goes on believing it took effect.
     */
    if (context.layer && spec.settableAt && !spec.settableAt.includes(context.layer)) {
      return `${spec.label} cannot be set on the ${context.layer}. `
        + `Set it on ${orList(spec.settableAt)} instead — `
        + 'a profile-wide value would repoint every persona in every project at once.';
    }

    /**
     * A `choicesFrom` value must be one of the caller's own.
     *
     * This was a UI hint the server never enforced, so `model` accepted any string and the failure
     * surfaced at every leaf, at run time, after a workspace had been built, as "Model X not found".
     */
    if (spec.choicesFrom === 'models' && context.models && !context.models.includes(String(value))) {
      return context.models.length
        ? `${spec.label} must be one of your models: ${context.models.join(', ')}.`
        : `${spec.label} cannot be set — you have no models deployed or registered.`;
    }

    if (spec.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) return `${spec.label} must be a number.`;
      if (spec.min !== undefined && value < spec.min) return `${spec.label} must be at least ${spec.min}.`;
      if (spec.max !== undefined && value > spec.max) return `${spec.label} must be at most ${spec.max}.`;
    }
    if (spec.type === 'boolean' && typeof value !== 'boolean') return `${spec.label} must be true or false.`;
    if (spec.type === 'string' && typeof value !== 'string') return `${spec.label} must be text.`;
    if (spec.type === 'enum' && spec.options && !spec.options.includes(value)) {
      return `${spec.label} must be one of ${spec.options.join(', ')}.`;
    }
  }
  return null;
}

/**
 * What the agent is ACTUALLY running with, right now.
 *
 * ── WHY THIS IS NOT `harnessDefaults` ──
 * The registry's `default` is the built-in constant, and for a long time the configuration page
 * showed exactly that and called it what the harness is set to. It is not: a promoted profile sits
 * on top of every run, so once anything is adopted the page describes a configuration nobody is
 * using. The whole point of the Lab is tuning the harness, and tuning against a number that is not
 * the one in force is worse than not showing a number at all.
 *
 * `think` in particular read as a hardcoded "off" while an adopted profile had turned it on.
 */
export function effectiveConfig(profileOverrides: Overrides = {}, kind?: ModelKind): EffectiveKnob[] {
  return TUNABLES
    .filter((t) => !t.engine || t.engine === kind)
    .map((t) => {
      const adopted = profileOverrides[t.key] !== undefined && profileOverrides[t.key] !== null;
      return {
        key: t.key,
        label: t.label,
        group: t.group,
        value: adopted ? profileOverrides[t.key] : t.default,
        source: adopted ? 'adopted' as const : 'harness' as const,
        ...(t.note ? { note: t.note } : {}),
        sourceFile: t.source,
      };
    });
}

/**
 * What the harness runs at today, as an overrides bag.
 *
 * The control arm. An experiment that wants a baseline variant uses this rather than an empty
 * overrides object, so the comparison is against stated values instead of against whatever the
 * defaults happened to be on the day.
 */
export function harnessDefaults(kind?: ModelKind): Overrides {
  const out: Overrides = {};
  for (const spec of TUNABLES) {
    if (spec.default === undefined) continue;
    if (spec.engine && spec.engine !== kind) continue;
    out[spec.key] = spec.default;
  }
  return out;
}
