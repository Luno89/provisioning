import { LOOP_TYPES, type LoopType } from './tree-types.js';
import { isGenericContainer } from './generic-tree-ops.js';

export const WORKFLOW_STAGE_TYPES = ['release', 'judge', 'land', 'resolve', 'accept', 'replan'] as const;
export type WorkflowStageType = typeof WORKFLOW_STAGE_TYPES[number];

export type WorkflowCondition =
  | { op: 'ranOk' | 'threw'; ref: string }
  | { op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; path: string; value: string | number | boolean }
  | { op: 'exists' | 'notExists'; path: string }
  | { op: 'and' | 'or'; conditions: WorkflowCondition[] }
  | { op: 'not'; condition: WorkflowCondition };

export interface WorkflowStageDefinition {
  id: string;
  name: string;
  stage: WorkflowStageType;
  optional?: boolean | undefined;
  runIf?: WorkflowCondition | string | undefined;
  retries?: number | undefined;
  retryDelayMs?: number | undefined;
}

export type WorkflowStageNode = WorkflowStageDefinition | WorkflowStageGroup | WorkflowStageLoop;

export interface WorkflowStageGroup {
  id: string;
  name: string;
  containerType: 'group';
  children: WorkflowStageNode[];
  optional?: boolean | undefined;
  runIf?: WorkflowCondition | string | undefined;
}

export interface WorkflowStageLoop {
  id: string;
  name: string;
  containerType: 'loop';
  loopType: LoopType;
  children: WorkflowStageNode[];
  optional?: boolean | undefined;
  runIf?: WorkflowCondition | string | undefined;
  maxIterations?: number | undefined;
  timeoutMs?: number | undefined;
  itemsFrom?: string | undefined;
}

export function isWorkflowContainerNode(node: WorkflowStageNode): node is WorkflowStageGroup | WorkflowStageLoop {
  return isGenericContainer(node);
}

export interface LeafWorkflowSpec {
  onSuccess: WorkflowStageNode[];
  onFailure: WorkflowStageNode[];
  timeoutMs?: number | undefined;
}

export function normalizeRunIf(runIf: WorkflowCondition | string): WorkflowCondition {
  return typeof runIf === 'string' ? { op: 'ranOk', ref: runIf } : runIf;
}

export interface WorkflowEvalContext {
  leaf: Record<string, unknown>;
  treeType: Record<string, unknown>;
  stages: Record<string, { ranOk: boolean; output: unknown }>;
}

export function getPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, segment) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[segment] : undefined),
    root,
  );
}

export function resolvePath(ctx: WorkflowEvalContext, path: string): unknown {
  const [root, ...rest] = path.split('.');
  const restPath = rest.join('.');
  if (root === 'leaf') return restPath ? getPath(ctx.leaf, restPath) : ctx.leaf;
  if (root === 'treeType') return restPath ? getPath(ctx.treeType, restPath) : ctx.treeType;
  if (root === 'stages') {
    const [stageId, ...stageRest] = rest;
    const entry = stageId ? ctx.stages[stageId] : undefined;
    if (!entry) return undefined;
    const stageRestPath = stageRest.join('.');
    return stageRestPath ? getPath(entry, stageRestPath) : entry;
  }
  return undefined;
}

export function evalCondition(cond: WorkflowCondition, ctx: WorkflowEvalContext): boolean {
  switch (cond.op) {
    case 'ranOk': return ctx.stages[cond.ref]?.ranOk === true;
    case 'threw': return ctx.stages[cond.ref] !== undefined && ctx.stages[cond.ref]!.ranOk === false;
    case 'eq': return resolvePath(ctx, cond.path) === cond.value;
    case 'neq': return resolvePath(ctx, cond.path) !== cond.value;
    case 'gt': return Number(resolvePath(ctx, cond.path)) > Number(cond.value);
    case 'gte': return Number(resolvePath(ctx, cond.path)) >= Number(cond.value);
    case 'lt': return Number(resolvePath(ctx, cond.path)) < Number(cond.value);
    case 'lte': return Number(resolvePath(ctx, cond.path)) <= Number(cond.value);
    case 'exists': return resolvePath(ctx, cond.path) !== undefined;
    case 'notExists': return resolvePath(ctx, cond.path) === undefined;
    case 'and': return cond.conditions.every((c) => evalCondition(c, ctx));
    case 'or': return cond.conditions.some((c) => evalCondition(c, ctx));
    case 'not': return !evalCondition(cond.condition, ctx);
  }
}

function validateConditionPath(path: string, seenIds: ReadonlySet<string>, nodeId: string): string | null {
  const [root, sub] = path.split('.', 2);
  if (root === 'stages') {
    if (!sub) return `Node "${nodeId}": condition path "${path}" must name a stage id after "stages.".`;
    if (!seenIds.has(sub)) return `Node "${nodeId}": condition path "${path}" references stage "${sub}", which must be an earlier stage.`;
    return null;
  }
  if (root === 'leaf' || root === 'treeType') return null;
  return `Node "${nodeId}": condition path "${path}" must start with "leaf.", "treeType.", or "stages.".`;
}

function validateWorkflowCondition(cond: unknown, seenIds: ReadonlySet<string>, nodeId: string): string | null {
  if (!cond || typeof cond !== 'object') return `Node "${nodeId}": condition must be an object.`;
  const c = cond as Record<string, unknown>;
  switch (c.op) {
    case 'ranOk':
    case 'threw': {
      if (typeof c.ref !== 'string' || !c.ref.trim()) return `Node "${nodeId}": condition.ref must be a stage id.`;
      if (!seenIds.has(c.ref)) return `Node "${nodeId}": condition references "${c.ref}", which must be an earlier stage.`;
      return null;
    }
    case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte': {
      if (typeof c.path !== 'string' || !c.path.trim()) return `Node "${nodeId}": condition.path must be a non-empty string.`;
      const pathErr = validateConditionPath(c.path, seenIds, nodeId);
      if (pathErr) return pathErr;
      if (!['string', 'number', 'boolean'].includes(typeof c.value)) {
        return `Node "${nodeId}": condition.value must be a string, number, or boolean.`;
      }
      return null;
    }
    case 'exists': case 'notExists': {
      if (typeof c.path !== 'string' || !c.path.trim()) return `Node "${nodeId}": condition.path must be a non-empty string.`;
      return validateConditionPath(c.path, seenIds, nodeId);
    }
    case 'and': case 'or': {
      if (!Array.isArray(c.conditions) || c.conditions.length === 0) {
        return `Node "${nodeId}": condition.conditions must be a non-empty array.`;
      }
      for (const sub of c.conditions) {
        const err = validateWorkflowCondition(sub, seenIds, nodeId);
        if (err) return err;
      }
      return null;
    }
    case 'not':
      return validateWorkflowCondition(c.condition, seenIds, nodeId);
    default:
      return `Node "${nodeId}": condition.op must be one of ranOk, threw, eq, neq, gt, gte, lt, lte, exists, notExists, and, or, not.`;
  }
}

function validateRunIf(runIf: unknown, seenIds: ReadonlySet<string>, nodeId: string): string | null {
  if (typeof runIf === 'string') {
    if (!runIf.trim()) return `Node "${nodeId}": runIf must be a stage id or a condition object.`;
    if (!seenIds.has(runIf)) return `Node "${nodeId}": runIf "${runIf}" must name an earlier stage.`;
    return null;
  }
  return validateWorkflowCondition(runIf, seenIds, nodeId);
}

export function validateWorkflowStageNodes(nodes: unknown, seenIds: Set<string>): string | null {
  if (!Array.isArray(nodes)) return 'leafWorkflow stage list must be an array.';

  for (const raw of nodes) {
    const n = raw as Record<string, unknown>;
    if (!n || typeof n !== 'object') return 'Each workflow node must be an object.';
    if (!n.id || typeof n.id !== 'string') return 'Each workflow node must have a string id.';
    if (!n.name || typeof n.name !== 'string') return 'Each workflow node must have a string name.';

    if ('containerType' in n) {
      if (n.containerType !== 'group' && n.containerType !== 'loop') {
        return `Node "${n.id as string}": containerType must be "group" or "loop".`;
      }
      if (n.optional !== undefined && typeof n.optional !== 'boolean') {
        return `Node "${n.id as string}": optional must be true or false.`;
      }
      if (n.runIf !== undefined) {
        const err = validateRunIf(n.runIf, seenIds, n.id as string);
        if (err) return err;
      }
      if (n.containerType === 'loop') {
        if (!(LOOP_TYPES as readonly string[]).includes(n.loopType as string)) {
          return `Node "${n.id as string}": loopType must be one of ${LOOP_TYPES.join(', ')}.`;
        }
        if (n.loopType === 'count' || n.loopType === 'until') {
          if (typeof n.maxIterations !== 'number' || !Number.isInteger(n.maxIterations) || n.maxIterations < 1) {
            return `Node "${n.id as string}": ${n.loopType} needs maxIterations to be a positive integer.`;
          }
        }
        if (n.loopType === 'forEach' && !(typeof n.itemsFrom === 'string' && n.itemsFrom.trim())) {
          return `Node "${n.id as string}": forEach needs itemsFrom to name an earlier stage's output path.`;
        }
        if (n.timeoutMs !== undefined && (typeof n.timeoutMs !== 'number' || n.timeoutMs <= 0)) {
          return `Node "${n.id as string}": timeoutMs must be a positive number.`;
        }
      }
      seenIds.add(n.id as string);
      const err = validateWorkflowStageNodes(n.children, seenIds);
      if (err) return err;
      continue;
    }

    if (!(WORKFLOW_STAGE_TYPES as readonly string[]).includes(n.stage as string)) {
      return `Node "${n.id as string}": stage must be one of ${WORKFLOW_STAGE_TYPES.join(', ')}.`;
    }
    if (n.retries !== undefined && (typeof n.retries !== 'number' || !Number.isInteger(n.retries) || n.retries < 0)) {
      return `Node "${n.id as string}": retries must be a non-negative integer.`;
    }
    if (n.retryDelayMs !== undefined && (typeof n.retryDelayMs !== 'number' || n.retryDelayMs < 0)) {
      return `Node "${n.id as string}": retryDelayMs must be a non-negative number.`;
    }
    if (n.optional !== undefined && typeof n.optional !== 'boolean') {
      return `Node "${n.id as string}": optional must be true or false.`;
    }
    if (n.runIf !== undefined) {
      const err = validateRunIf(n.runIf, seenIds, n.id as string);
      if (err) return err;
    }
    seenIds.add(n.id as string);
  }
  return null;
}

export function validateLeafWorkflowSpec(spec: unknown): string | null {
  if (!spec || typeof spec !== 'object') return 'leafWorkflow must be an object.';
  const s = spec as Record<string, unknown>;
  const successErr = validateWorkflowStageNodes(s.onSuccess, new Set<string>());
  if (successErr) return successErr;
  const failureErr = validateWorkflowStageNodes(s.onFailure, new Set<string>());
  if (failureErr) return failureErr;
  if (s.timeoutMs !== undefined && (typeof s.timeoutMs !== 'number' || s.timeoutMs <= 0)) {
    return 'leafWorkflow.timeoutMs must be a positive number.';
  }
  return null;
}

export const DEFAULT_LEAF_WORKFLOW: LeafWorkflowSpec = {
  onSuccess: [
    { id: 'release', name: 'Release dependents', stage: 'release' },
    { id: 'judge', name: 'Judge', stage: 'judge', optional: true },
    { id: 'land', name: 'Land', stage: 'land' },
    {
      id: 'resolve', name: 'Resolve landing conflicts', stage: 'resolve',
      runIf: { op: 'gt', path: 'stages.land.output.stuck.length', value: 0 },
    },
    { id: 'accept', name: 'Accept request', stage: 'accept' },
    { id: 'replan', name: 'Replan', stage: 'replan' },
  ],
  onFailure: [
    { id: 'release', name: 'Release dependents', stage: 'release' },
    { id: 'land', name: 'Land', stage: 'land' },
  ],
};
