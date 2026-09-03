import { NO_THINKING } from './sampling.js';
import { samplingFor } from './pack-sampling.js';
import type { BudgetConfig, PromptConfig, SamplingConfig } from '@koala/harness-types';
import { buildAgentPrompt } from './sandbox-tools.js';
import { toolsNeeding } from './tool-registry.js';
import type { ToolRepositoryItem } from './tool-seeds.js';
import {
  DEFAULT_WORKSPACE_LANGUAGE,
  MAX_WORKSPACE_SECONDS,
  describeSandbox,
  describeWorkerSandbox,
} from './workspace-spec.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';
import { MAX_DEPTH, MAX_CHILDREN_PER_LEAF, MAX_LEAF_ATTEMPTS } from './leaves.js';
import { MAX_VARIANTS, MAX_REPEATS, MAX_TASK_CHARS, MAX_TASKS, MAX_TOTAL_RUNS } from './experiments.js';
import { TUNABLES, effectiveConfig, type EffectiveKnob } from './tunables.js';
import type { Overrides } from '@koala/harness-types';
import { buildTaskAuthorPrompt } from './experiment-authoring.js';
import type { HarnessConfig, HarnessSection, HarnessSetting } from '@koala/harness-types';

export type { HarnessConfig, HarnessSection, HarnessSetting };

export const TUNABLE = ['think', 'maxSteps', 'temperature', 'language', 'model'] as const;

function withChoices(tunables: typeof TUNABLES, models: HarnessConfig['models']): typeof TUNABLES {
  return tunables.map((t) => {
    if (t.choicesFrom !== 'models') return t;
    return {
      ...t,
      choices: models.map((m) => ({
        value: m.id,
        label: m.name,
        note: [m.model, m.kind ?? m.source].filter(Boolean).join(' · '),
      })),
    };
  });
}

export function buildHarnessConfig(
  profileOverrides: Overrides = {},
  models: HarnessConfig['models'] = [],
  /** The caller's catalogue. The tool panels describe rows now, not a file. */
  toolRows: readonly ToolRepositoryItem[] = [],
  /** The caller's workspace images, for the same reason. */
  images: readonly WorkspaceImageSpec[] = [],
  /** The pack whose sampler the panels describe. */
  sampling?: SamplingConfig,
  /** And its budget, for the same reason. */
  budget?: BudgetConfig,
  /** And the sections it composes around a persona's prompt. */
  prompt?: PromptConfig,
): HarnessConfig {
  /**
   * Which of the caller's tools need a sandbox and which do not, asked of the registry rather than
   * of a field on the row. There is no "planning surface" any more -- a pack's grant list decides
   * what a given run is offered -- so what a panel can honestly report is the resource split.
   */
  const needsSandbox = new Set(toolsNeeding('sandbox'));
  const sandboxToolNames = () => toolRows.filter((t) => needsSandbox.has(t.name)).map((t) => t.name).join(', ');
  const unsandboxedToolNames = () => toolRows.filter((t) => !needsSandbox.has(t.name)).map((t) => t.name).join(', ');
  const live = effectiveConfig(profileOverrides, 'tabbyapi', sampling, budget);
  const knob = (key: string): EffectiveKnob | undefined => live.find((k) => k.key === key);

  const fromKnob = (key: string, label?: string): HarnessSetting => {
    const k = knob(key);
    return {
      label: label ?? k?.label ?? key,
      value: k?.value === undefined ? 'unset' : String(k.value),
      ...(k?.note ? { note: k.note } : {}),
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
          fromKnob('think'),
          fromKnob('maxSteps'),
          fromKnob('max_tokens'),
          { label: 'Tool result cap', value: `${budget?.toolResultChars ?? 'unset'} chars`, note: 'Truncated from the FRONT, so exit codes and errors at the tail survive.', source: 'the pack' },
          { label: 'Tools', value: sandboxToolNames(), source: 'the tool catalogue' },
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
          { label: 'Loop guards', value: JSON.stringify(samplingFor(sampling, 'conversation', 'tabbyapi')), source: 'the pack' },
          { label: '/plan token budget', value: String(budget?.replyTokens.plan ?? 'unset'), note: 'Measured: one turn produced 7,908 chars of reasoning before 1,210 of answer. At 900 the reply never arrived, silently.', source: 'the pack' },
          { label: 'Tool rounds per turn', value: String(budget?.rounds ?? 'unset'), source: 'the pack' },
          { label: 'Proposals per reply', value: String(budget?.proposalsPerReply ?? 'unset'), source: 'the pack' },
          { label: 'Grantable without a sandbox', value: unsandboxedToolNames(), note: 'A pack grants from the whole catalogue; these are the ones a run with no sandbox can still serve.', source: 'the tool catalogue' },
        ],
      },
      {
        id: 'sandbox',
        title: 'Sandbox',
        summary: 'Where the work runs. No service-account token, no general egress, no DNS.',
        settings: [
          { label: 'Default language', value: DEFAULT_WORKSPACE_LANGUAGE, source: 'the workspace-image catalogue' },
          { label: 'Lifetime', value: `${MAX_WORKSPACE_SECONDS / 60} min`, note: 'Backstop for a pod nobody is watching; teardown normally happens when the attempt ends.', source: 'lib/workspace-spec.ts' },
          { label: 'Leaf depth / fan-out', value: `${MAX_DEPTH} deep, ${MAX_CHILDREN_PER_LEAF} children`, note: 'Caps alone still permit 3×10×10 = 300 workspaces, which is why budgets are on the root.', source: 'lib/leaves.ts' },
        ],
      },
    ],
    prompts: [
      { id: 'agent', title: 'Agent system prompt', text: buildAgentPrompt(images, undefined, '<the leaf being worked on>', budget?.run.steps ?? 0) },
      { id: 'sandbox', title: 'Sandbox description (generated)', text: describeSandbox(images) },
      { id: 'discipline', title: 'Tool discipline', text: prompt?.sections.toolDiscipline ?? '' },
      { id: 'plan', title: 'Plan mode (the planner pack\u2019s contract)', text: prompt?.sections.planning ?? '' },
      { id: 'plan-sandbox', title: 'Environment note shown to a planner', text: describeWorkerSandbox(images) },
      { id: 'ambient', title: 'Ambient proposing', text: prompt?.sections.ambientPlanning ?? '' },
      { id: 'authoring', title: 'Task authoring (Koala writes the suite)', text: buildTaskAuthorPrompt(images) },
    ],
    languages: images.map((i) => ({ id: i.id, image: i.image, summary: i.summary })),
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
