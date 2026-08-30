import type { ModelKind } from './model-registry.js';
import { TOOL_TURN_MAX_TOKENS, THINKING_TURN_MAX_TOKENS } from './sampling.js';
import { samplingFor } from './pack-sampling.js';
import type { SamplingConfig } from '@koala/harness-types';
import { MAX_AGENT_TOKENS, MAX_AGENT_STEPS, MAX_TOOL_RESULT_CHARS } from './sandbox-tools.js';
import type { EffectiveKnob, Overrides, Tunable, TunablePlacement, TunableType } from '@koala/harness-types';

export type { EffectiveKnob, Overrides, Tunable, TunablePlacement, TunableType };

export const TUNABLES: Tunable[] = [
  {
    key: 'temperature',
    label: 'Temperature',
    group: 'sampling',
    type: 'number',
    placement: 'body',
    min: 0,
    max: 2,
    step: 0.05,
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

  {
    key: 'think',
    label: 'Reasoning on dispatch turns',
    group: 'sampling',
    type: 'boolean',
    placement: 'template_vars',
    field: 'enable_thinking',
    default: false,
    suggested: [false, true],
    note: 'Off by default. Measured: with reasoning on, a dispatch turn can spend its whole budget '
      + 'deliberating, emit no tool call at all, and read to the loop as a model that answered in prose.',
    source: 'lib/sampling.ts',
  },

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
    choicesFrom: 'models',
    settableAt: ['persona', 'pack', 'request'],
    note: 'Which of your model APIs to run against — a deployed engine or a registered endpoint. '
      + 'Resolved to a base URL before the call, so two engines can be compared on the same suite.',
    source: 'services/ModelService.ts',
  },

  {
    key: 'systemPrompt',
    label: 'System prompt (full replace)',
    group: 'prompt',
    type: 'string',
    placement: 'loop',
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

export const loopKeys = (): string[] =>
  TUNABLES.filter((t) => t.placement === 'loop').map((t) => t.key);

export function applyOverrides(
  body: Record<string, unknown>,
  overrides: Overrides,
  kind?: ModelKind,
): { body: Record<string, unknown>; unsupported: string[] } {
  const next = { ...body };
  const unsupported: string[] = [];

  for (const [key, value] of Object.entries(overrides)) {
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
      const existing = (next.template_vars ?? {}) as Record<string, unknown>;
      next.template_vars = { ...existing, [field]: value };
    } else {
      next[field] = value;
    }
  }

  return { body: next, unsupported };
}

export interface OverrideContext {
  layer?: 'profile' | 'persona' | 'pack' | 'request';
  models?: string[];
}

const orList = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;

export function validateOverrides(overrides: Overrides, context: OverrideContext = {}): string | null {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const spec = BY_KEY.get(key);
    if (!spec) return `Unknown setting "${key}".`;
    if (value === null) continue;

    if (context.layer && spec.settableAt && !spec.settableAt.includes(context.layer)) {
      return `${spec.label} cannot be set on the ${context.layer}. `
        + `Set it on ${orList(spec.settableAt)} instead — `
        + 'a profile-wide value would repoint every persona in every project at once.';
    }

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
 * A knob's value when nothing has adopted it comes from the pack's sampler, not from this table.
 * The table describes the knob — range, label, why it exists; the pack says what it is set to.
 */
export function effectiveConfig(
  profileOverrides: Overrides = {},
  kind?: ModelKind,
  sampling?: SamplingConfig,
): EffectiveKnob[] {
  const fromPack = { ...samplingFor(sampling, 'tool-turn', kind), ...samplingFor(sampling, 'conversation', kind) };
  return TUNABLES
    .filter((t) => !t.engine || t.engine === kind)
    .map((t) => {
      const adopted = profileOverrides[t.key] !== undefined && profileOverrides[t.key] !== null;
      return {
        key: t.key,
        label: t.label,
        group: t.group,
        value: adopted ? profileOverrides[t.key] : fromPack[t.key] ?? t.default,
        source: adopted ? 'adopted' as const : 'harness' as const,
        ...(t.note ? { note: t.note } : {}),
        sourceFile: t.source,
      };
    });
}

export function harnessDefaults(kind?: ModelKind, sampling?: SamplingConfig): Overrides {
  const out: Overrides = {
    ...samplingFor(sampling, 'tool-turn', kind),
    ...(kind ? {} : {}),
  } as Overrides;
  for (const spec of TUNABLES) {
    if (spec.default === undefined) continue;
    if (spec.engine && spec.engine !== kind) continue;
    out[spec.key] = spec.default;
  }
  return out;
}
