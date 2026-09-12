import type { TreeType } from '../../types/grove.js';

export type {
  TreeType, TreeTypeFile, TreeTypePacks, TreeTypePackRole, ValidationRecipe,
  ValidationCheckDefinition, ValidationCheckType, K8sProbeKind, WorkspaceLanguage, PersonaEgressRule,
  CustomStepDefinition, CustomStepField, CustomStepFieldKind,
  RecipeNode, RecipeGroup, RecipeLoop, LoopType,
  WorkflowStageNode, WorkflowStageDefinition, WorkflowStageGroup, WorkflowStageLoop,
  WorkflowStageType, WorkflowCondition, LeafWorkflowSpec,
} from '../../types/grove.js';
export {
  VALIDATION_CHECK_TYPES, K8S_PROBE_KINDS, TREE_TYPE_PACK_ROLES, LOOP_TYPES, isContainerNode,
  WORKFLOW_STAGE_TYPES, isWorkflowContainerNode,
} from '../../types/grove.js';
import type { WorkflowStageNode, LeafWorkflowSpec } from '../../types/grove.js';

export const DEFAULT_LEAF_WORKFLOW: LeafWorkflowSpec = {
  onSuccess: [
    { id: 'release', name: 'Release dependents', stage: 'release' },
    { id: 'judge', name: 'Judge', stage: 'judge', optional: true },
    { id: 'land', name: 'Land', stage: 'land' },
    { id: 'resolve', name: 'Resolve landing conflicts', stage: 'resolve', runIf: { op: 'gt', path: 'stages.land.output.stuck.length', value: 0 } },
    { id: 'accept', name: 'Accept request', stage: 'accept' },
    { id: 'replan', name: 'Replan', stage: 'replan' },
  ] satisfies WorkflowStageNode[],
  onFailure: [
    { id: 'release', name: 'Release dependents', stage: 'release' },
    { id: 'land', name: 'Land', stage: 'land' },
  ] satisfies WorkflowStageNode[],
};

export const card = 'bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-xl';

export const field =
  'w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-lg px-3 py-2 text-sm '
  + 'text-slate-200 focus:border-[var(--leaf)] focus:outline-none';

export const label = 'text-[10px] uppercase tracking-widest text-slate-500 mb-1 block';

let nextId = 0;
/** A short, unique-enough id for a new step or file row — not persisted identity, just a React key
 * and a value a `runIf` can reference until the row is renamed. */
export function draftId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextId}`;
}

/** Matches `SLUG` in `apps/backend/src/lib/tree-types.ts` — a valid tree-type id. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function blankTreeType(): TreeType {
  return {
    id: '',
    label: '',
    summary: '',
    language: 'node',
    produces: 'service',
    doneMeans: '',
    files: [],
    validationRecipe: { type: 'command', checks: [] },
  };
}
