import type { Leaf } from '../components/leaf-types'

export type { Leaf }

export interface Tree {
  id: string
  name: string
  type: string
  goal?: string
  branchCount: number
  updatedAt: string
}

export interface Branch {
  id: string
  title: string
  treeId?: string
  ownerId?: string
  createdAt?: string
  updatedAt?: string
}

export interface TreeTypeFile {
  path: string
  content: string
  executable?: boolean | undefined
}

export const VALIDATION_CHECK_TYPES = [
  'file-exists', 'content-matches', 'run-command', 'http-probe', 'mcp-probe',
  'git-tracked', 'k8s-probe', 'wait-for', 'custom',
] as const
export type ValidationCheckType = typeof VALIDATION_CHECK_TYPES[number]

export const K8S_PROBE_KINDS = ['pod', 'deployment', 'service'] as const
export type K8sProbeKind = typeof K8S_PROBE_KINDS[number]

export interface ValidationCheckDefinition {
  id: string
  name: string
  description?: string | undefined
  type: ValidationCheckType
  target?: string | undefined
  command?: string | undefined
  pattern?: string | undefined
  expectedStatus?: number | undefined
  timeoutMs?: number | undefined
  optional?: boolean | undefined
  runIf?: string | undefined
  retries?: number | undefined
  retryDelayMs?: number | undefined
  kind?: K8sProbeKind | undefined
  namespace?: string | undefined
  waitForType?: Exclude<ValidationCheckType, 'wait-for'> | undefined
  pollIntervalMs?: number | undefined
  customStepId?: string | undefined
  params?: Record<string, string | number | boolean> | undefined
}

export type CustomStepFieldKind = 'string' | 'number' | 'boolean'

export interface CustomStepField {
  key: string
  label: string
  kind: CustomStepFieldKind
  defaultValue?: string | number | boolean | undefined
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `CustomStepDefinition` in `apps/backend/src/lib/custom-steps.ts`, which is the authority.
 */
export interface CustomStepDefinition {
  id: string
  ownerId?: string | undefined
  name: string
  description?: string | undefined
  fields: CustomStepField[]
  command: string
  timeoutMs?: number | undefined
  createdAt?: string | undefined
  updatedAt?: string | undefined
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `RecipeNode`/`RecipeGroup`/`RecipeLoop` in `apps/backend/src/lib/tree-types.ts`, which is
 * the authority. `containerType` is the discriminant (not `kind`, which a leaf already uses for
 * k8s-probe's resource kind) — a node with no `containerType` is a leaf, exactly as before, so every
 * already-persisted flat recipe still parses unchanged.
 */
export type RecipeNode = ValidationCheckDefinition | RecipeGroup | RecipeLoop

export interface RecipeGroup {
  id: string
  name: string
  containerType: 'group'
  children: RecipeNode[]
  optional?: boolean | undefined
  runIf?: string | undefined
}

export const LOOP_TYPES = ['count', 'until', 'forEach'] as const
export type LoopType = typeof LOOP_TYPES[number]

export interface RecipeLoop {
  id: string
  name: string
  containerType: 'loop'
  loopType: LoopType
  children: RecipeNode[]
  optional?: boolean | undefined
  runIf?: string | undefined
  maxIterations?: number | undefined
  timeoutMs?: number | undefined
  itemsCommand?: string | undefined
}

export function isContainerNode(node: RecipeNode): node is RecipeGroup | RecipeLoop {
  return 'containerType' in node
}

export interface ValidationRecipe {
  type: 'document' | 'command' | 'runtime-service'
  checks: RecipeNode[]
  timeoutMs?: number | undefined
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `leaf-workflow-types.ts` in `apps/backend/src/lib/`, which is the authority. The stage
 * tree is structurally the same shape as `RecipeNode` (a `containerType` discriminant, absent on a
 * leaf) but for orchestration stages instead of validation checks.
 */
export const WORKFLOW_STAGE_TYPES = ['release', 'judge', 'land', 'resolve', 'accept', 'replan'] as const
export type WorkflowStageType = typeof WORKFLOW_STAGE_TYPES[number]

export type WorkflowCondition =
  | { op: 'ranOk' | 'threw'; ref: string }
  | { op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; path: string; value: string | number | boolean }
  | { op: 'exists' | 'notExists'; path: string }
  | { op: 'and' | 'or'; conditions: WorkflowCondition[] }
  | { op: 'not'; condition: WorkflowCondition }

export interface WorkflowStageDefinition {
  id: string
  name: string
  stage: WorkflowStageType
  optional?: boolean | undefined
  runIf?: WorkflowCondition | string | undefined
  retries?: number | undefined
  retryDelayMs?: number | undefined
}

export type WorkflowStageNode = WorkflowStageDefinition | WorkflowStageGroup | WorkflowStageLoop

export interface WorkflowStageGroup {
  id: string
  name: string
  containerType: 'group'
  children: WorkflowStageNode[]
  optional?: boolean | undefined
  runIf?: WorkflowCondition | string | undefined
}

export interface WorkflowStageLoop {
  id: string
  name: string
  containerType: 'loop'
  loopType: LoopType
  children: WorkflowStageNode[]
  optional?: boolean | undefined
  runIf?: WorkflowCondition | string | undefined
  maxIterations?: number | undefined
  timeoutMs?: number | undefined
  itemsFrom?: string | undefined
}

export function isWorkflowContainerNode(node: WorkflowStageNode): node is WorkflowStageGroup | WorkflowStageLoop {
  return 'containerType' in node
}

export interface LeafWorkflowSpec {
  onSuccess: WorkflowStageNode[]
  onFailure: WorkflowStageNode[]
  timeoutMs?: number | undefined
}

export interface AutoAcceptPolicy {
  enabled: boolean
  requirePersona: boolean
  max: number
  minTitleChars: number
  minBodyChars: number
}

export interface AutoAcceptVerdict {
  accept: boolean
  reason: string
}

export interface LeafExplainRole {
  id: string
  name: string
  slug: string
}

export interface LeafExplain {
  leaf: { id: string; title: string; status: string }
  treeType?: { id: string; label: string; summary: string } | undefined
  roles: Partial<Record<TreeTypePackRole, LeafExplainRole>>
  validationRecipe?: ValidationRecipe | undefined
  leafWorkflow: LeafWorkflowSpec
  autoAccept: { policy: AutoAcceptPolicy; verdict: AutoAcceptVerdict }
}

export const TREE_TYPE_PACK_ROLES = ['planner', 'judge', 'merger'] as const
export type TreeTypePackRole = typeof TREE_TYPE_PACK_ROLES[number]

export interface TreeTypePacks {
  planner?: string | undefined
  judge?: string | undefined
  merger?: string | undefined
}

export type WorkspaceLanguage = 'node' | 'python' | 'go' | 'base'

export interface PersonaEgressRule {
  cidr?: string | undefined
  namespace?: string | undefined
  ports?: number[] | undefined
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `TreeTypeSpec` in `apps/backend/src/lib/tree-types.ts`, which is the authority. Kept in
 * sync by hand — there is no shared package between the two halves for this shape.
 */
export interface TreeType {
  id: string
  ownerId?: string | undefined
  label: string
  summary: string
  language: WorkspaceLanguage
  produces: 'service' | 'artefact'
  doneMeans: string
  requireSources?: boolean | undefined
  files: TreeTypeFile[]
  validationRecipe?: ValidationRecipe | undefined
  leafWorkflow?: LeafWorkflowSpec | undefined
  defaultBindings?: string[] | undefined
  egress?: PersonaEgressRule[] | undefined
  env?: { name: string; value: string }[] | undefined
  packs?: TreeTypePacks | undefined
  autoAccept?: {
    enabled?: boolean | undefined
    requirePersona?: boolean | undefined
    max?: number | undefined
    minTitleChars?: number | undefined
    minBodyChars?: number | undefined
  } | undefined
  duplicateThreshold?: number | undefined
  verdictPolicy?: VerdictPolicy | undefined
}

export interface VerdictPolicy {
  requireVerify?: boolean | undefined
  requireArtifacts?: boolean | undefined
  combineMode?: 'all' | 'any' | undefined
}
