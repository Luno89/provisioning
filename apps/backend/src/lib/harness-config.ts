/**
 * What the harness is currently set to — assembled from the real modules, never restated.
 *
 * Every value here is READ from the constant that the running code uses. A hand-maintained copy
 * would be worse than no page at all: someone would tune a sampler, read a stale number in the UI,
 * and conclude the change had no effect. If a setting is not reachable from its source module, it
 * does not belong on this list.
 */
import { toolTurnSampling, conversationSampling, TOOL_TURN_MAX_TOKENS, TOOL_DISCIPLINE_PROMPT, NO_THINKING } from './sampling.js';
import { SANDBOX_TOOLS, MAX_AGENT_STEPS, MAX_TOOL_RESULT_CHARS, buildAgentPrompt } from './sandbox-tools.js';
import { LEAF_TOOLS, MAX_TOOL_ROUNDS } from './leaf-tools.js';
import { PLAN_MODE_MAX_TOKENS, MAX_PROPOSALS_PER_REPLY, PLAN_SYSTEM_PROMPT, AMBIENT_PROPOSAL_PROMPT } from './plan-mode.js';
import {
  WORKSPACE_IMAGES,
  DEFAULT_WORKSPACE_LANGUAGE,
  MAX_WORKSPACE_SECONDS,
  describeSandbox,
  type WorkspaceLanguage,
} from './workspace-spec.js';
import { MAX_DEPTH, MAX_CHILDREN_PER_LEAF, MAX_LEAF_ATTEMPTS } from './leaves.js';
import { MAX_VARIANTS, MAX_REPEATS, MAX_TASK_CHARS, MAX_TASKS, MAX_TOTAL_RUNS } from './experiments.js';
import { TUNABLES, effectiveConfig, type EffectiveKnob } from './tunables.js';
import type { Overrides } from '@koala/harness-types';
import { buildTaskAuthorPrompt } from './experiment-authoring.js';
import type { HarnessConfig, HarnessSection, HarnessSetting } from '@koala/harness-types';

/** Re-exported: this whole object is the payload the Lab renders. */
export type { HarnessConfig, HarnessSection, HarnessSetting };

/** The settings an experiment is allowed to vary. Keep in step with ExperimentOverrides. */
export const TUNABLE = ['think', 'maxSteps', 'temperature', 'language', 'model'] as const;

/**
 * Fills in the pickable values for knobs whose options are discovered rather than declared.
 *
 * Kept here rather than in the registry because the registry is static and shared, while this list
 * is per-caller: one tenant's endpoints are not another's. A knob with `choicesFrom` and nothing to
 * offer keeps an empty list rather than being dropped — "you have no models" is the answer, and a
 * missing knob would read as "this cannot be varied".
 */
function withChoices(tunables: typeof TUNABLES, models: HarnessConfig['models']): typeof TUNABLES {
  return tunables.map((t) => {
    if (t.choicesFrom !== 'models') return t;
    return {
      ...t,
      choices: models.map((m) => ({
        value: m.id,
        label: m.name,
        // The served model and where it came from, because two deployments of the same engine are
        // otherwise told apart only by a name someone typed.
        note: [m.model, m.kind ?? m.source].filter(Boolean).join(' · '),
      })),
    };
  });
}

/**
 * The configuration surface.
 *
 * Takes the promoted profile because a page describing "what the harness is set to" that ignores
 * what has been adopted is describing a configuration nobody runs. Every value a profile can change
 * is read through `effectiveConfig`, and says whether it is the built-in or an adopted one.
 */
export function buildHarnessConfig(
  profileOverrides: Overrides = {},
  models: HarnessConfig['models'] = [],
): HarnessConfig {
  const tabby = toolTurnSampling('tabbyapi');
  const portable = toolTurnSampling(undefined);

  // Engine-gated knobs are shown for TabbyAPI, which is what this deployment serves; a knob that
  // would be dropped elsewhere is marked as such in the registry table.
  const live = effectiveConfig(profileOverrides, 'tabbyapi');
  const knob = (key: string): EffectiveKnob | undefined => live.find((k) => k.key === key);

  /** A setting whose value is whatever the run actually uses, adopted or built in. */
  const fromKnob = (key: string, label?: string): HarnessSetting => {
    const k = knob(key);
    return {
      label: label ?? k?.label ?? key,
      value: k?.value === undefined ? 'unset' : String(k.value),
      ...(k?.note ? { note: k.note } : {}),
      // The adopted case is called out in the source line, because "where do I change this" has a
      // different answer once a profile supplies it.
      source: k?.source === 'adopted' ? `adopted default (was ${k.sourceFile})` : (k?.sourceFile ?? ''),
    };
  };

  return {
    sections: [
      {
        id: 'agent',
        title: 'Agent loop',
        summary: 'One model↔sandbox turn at a time, until the model calls finish or runs out of steps.',
        settings: [
          // Read, not stated. This was a literal 'off' while an adopted profile had turned
          // reasoning on — the page contradicting the runs it was meant to describe.
          fromKnob('think'),
          fromKnob('maxSteps'),
          fromKnob('max_tokens'),
          { label: 'Tool result cap', value: `${MAX_TOOL_RESULT_CHARS} chars`, note: 'Truncated from the FRONT, so exit codes and errors at the tail survive.', source: 'lib/sandbox-tools.ts' },
          { label: 'Tools', value: SANDBOX_TOOLS.map((t) => t.function.name).join(', '), source: 'lib/sandbox-tools.ts' },
          { label: 'Retries per leaf', value: String(MAX_LEAF_ATTEMPTS), note: 'Each retry re-reads the DB, so it sees why the last attempt failed.', source: 'lib/leaves.ts' },
        ],
      },
      {
        id: 'sampling',
        title: 'Sampling',
        summary: 'Guards against the decoding loop — repeated identical lines that never reach an answer.',
        settings: [
          fromKnob('temperature', 'Dispatch temperature'),
          fromKnob('frequency_penalty'),
          {
            label: 'DRY (TabbyAPI only)',
            value: `multiplier ${knob('dry_multiplier')?.value}, base ${knob('dry_base')?.value}, `
              + `allowed length ${knob('dry_allowed_length')?.value}`,
            note:
              'Penalises repeated SEQUENCES, so it cuts a repeating line without touching legitimately ' +
              'repetitive code. Sent only when the platform deployed the engine and knows it is TabbyAPI — ' +
              'a strict server would reject the unknown field outright.',
            source: 'lib/sampling.ts',
          },
          { label: 'Thinking switch', value: JSON.stringify(NO_THINKING), note: 'Must be nested under template_vars. At the top level it is ignored and output degrades.', source: 'lib/sampling.ts' },
        ],
      },
      {
        id: 'chat',
        title: 'Planning chat',
        summary: 'Reasoning stays ON here — it is what makes the conversation worth having.',
        settings: [
          { label: 'Reasoning', value: 'on', note: 'Deliberate decision. Only the decoding pathology is suppressed.', source: 'index.ts chat route' },
          { label: 'Loop guards', value: JSON.stringify(conversationSampling('tabbyapi')), source: 'lib/sampling.ts' },
          { label: '/plan token budget', value: String(PLAN_MODE_MAX_TOKENS), note: 'Measured: one turn produced 7,908 chars of reasoning before 1,210 of answer. At 900 the reply never arrived, silently.', source: 'lib/plan-mode.ts' },
          { label: 'Tool rounds per turn', value: String(MAX_TOOL_ROUNDS), source: 'lib/leaf-tools.ts' },
          { label: 'Proposals per reply', value: String(MAX_PROPOSALS_PER_REPLY), source: 'lib/plan-mode.ts' },
          { label: 'Planning tools', value: LEAF_TOOLS.map((t) => t.function.name).join(', '), source: 'lib/leaf-tools.ts' },
        ],
      },
      {
        id: 'sandbox',
        title: 'Sandbox',
        summary: 'Where the work runs. No service-account token, no general egress, no DNS.',
        settings: [
          { label: 'Default language', value: DEFAULT_WORKSPACE_LANGUAGE, source: 'lib/workspace-spec.ts' },
          { label: 'Lifetime', value: `${MAX_WORKSPACE_SECONDS / 60} min`, note: 'Backstop for a pod nobody is watching; teardown normally happens when the attempt ends.', source: 'lib/workspace-spec.ts' },
          { label: 'Leaf depth / fan-out', value: `${MAX_DEPTH} deep, ${MAX_CHILDREN_PER_LEAF} children`, note: 'Caps alone still permit 3×10×10 = 300 workspaces, which is why budgets are on the root.', source: 'lib/leaves.ts' },
        ],
      },
    ],
    prompts: [
      { id: 'agent', title: 'Agent system prompt', text: buildAgentPrompt(undefined, '<the leaf being worked on>') },
      { id: 'sandbox', title: 'Sandbox description (generated)', text: describeSandbox() },
      { id: 'discipline', title: 'Tool discipline', text: TOOL_DISCIPLINE_PROMPT },
      { id: 'plan', title: 'Plan mode', text: PLAN_SYSTEM_PROMPT },
      { id: 'ambient', title: 'Ambient proposing', text: AMBIENT_PROPOSAL_PROMPT },
      // Added when authoring shipped. This page claims to show what the model is ACTUALLY told, so
      // a prompt that exists and is missing here makes the claim false for every other entry too.
      { id: 'authoring', title: 'Task authoring (Koala writes the suite)', text: buildTaskAuthorPrompt() },
    ],
    languages: (Object.keys(WORKSPACE_IMAGES) as WorkspaceLanguage[]).map((id) => ({
      id,
      image: WORKSPACE_IMAGES[id].image,
      summary: WORKSPACE_IMAGES[id].summary,
    })),
    // Passed through as given: this function reads constants, and which APIs a caller can reach is
    // not a constant. The route supplies it.
    models,
    limits: {
      maxVariants: MAX_VARIANTS,
      maxRepeats: MAX_REPEATS,
      maxTaskChars: MAX_TASK_CHARS,
      maxTasks: MAX_TASKS,
      maxTotalRuns: MAX_TOTAL_RUNS,
    },
    tunables: withChoices(TUNABLES, models),
    effective: live,
  };
}
