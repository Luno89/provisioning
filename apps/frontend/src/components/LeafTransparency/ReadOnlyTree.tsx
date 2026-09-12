import { Folder, Repeat, CornerDownRight } from 'lucide-react';
import {
  isContainerNode, isWorkflowContainerNode,
  type RecipeNode, type WorkflowStageNode, type WorkflowCondition, type LoopType,
} from '../TreeTypes/shared.js';
import { STEP_TYPE_LABELS } from '../TreeTypes/Recipe/stepTemplates.js';
import { STAGE_LABELS } from '../TreeTypes/LeafWorkflow/stageTemplates.js';

const LOOP_TYPE_LABELS: Record<LoopType, string> = {
  count: 'Repeat N times',
  until: 'Repeat until it passes',
  forEach: 'For each item',
};

export interface DisplayNode {
  id: string;
  name: string;
  kindLabel: string;
  isContainer: boolean;
  loopType?: 'count' | 'until' | 'forEach' | undefined;
  maxIterations?: number | undefined;
  optional?: boolean | undefined;
  runIfLabel?: string | undefined;
  children: DisplayNode[];
}

function findRecipeById(nodes: readonly RecipeNode[], id: string): RecipeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (isContainerNode(n)) {
      const found = findRecipeById(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function recipeToDisplay(nodes: readonly RecipeNode[], root: readonly RecipeNode[] = nodes): DisplayNode[] {
  return nodes.map((n) => {
    const runIfLabel = n.runIf ? `runs only if "${findRecipeById(root, n.runIf)?.name ?? n.runIf}" passed` : undefined;
    if (isContainerNode(n)) {
      return {
        id: n.id, name: n.name, optional: n.optional, runIfLabel,
        kindLabel: n.containerType === 'loop' ? LOOP_TYPE_LABELS[n.loopType] : 'Group',
        isContainer: true,
        loopType: n.containerType === 'loop' ? n.loopType : undefined,
        maxIterations: n.containerType === 'loop' ? n.maxIterations : undefined,
        children: recipeToDisplay(n.children, root),
      };
    }
    return {
      id: n.id, name: n.name, optional: n.optional, runIfLabel,
      kindLabel: STEP_TYPE_LABELS[n.type], isContainer: false, children: [],
    };
  });
}

function findWorkflowById(nodes: readonly WorkflowStageNode[], id: string): WorkflowStageNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (isWorkflowContainerNode(n)) {
      const found = findWorkflowById(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function describeCondition(cond: WorkflowCondition, root: readonly WorkflowStageNode[]): string {
  switch (cond.op) {
    case 'ranOk': return `"${findWorkflowById(root, cond.ref)?.name ?? cond.ref}" ran ok`;
    case 'threw': return `"${findWorkflowById(root, cond.ref)?.name ?? cond.ref}" threw`;
    case 'eq': return `${cond.path} = ${JSON.stringify(cond.value)}`;
    case 'neq': return `${cond.path} ≠ ${JSON.stringify(cond.value)}`;
    case 'gt': return `${cond.path} > ${JSON.stringify(cond.value)}`;
    case 'gte': return `${cond.path} ≥ ${JSON.stringify(cond.value)}`;
    case 'lt': return `${cond.path} < ${JSON.stringify(cond.value)}`;
    case 'lte': return `${cond.path} ≤ ${JSON.stringify(cond.value)}`;
    case 'exists': return `${cond.path} is set`;
    case 'notExists': return `${cond.path} is not set`;
    case 'and': return cond.conditions.map((c) => describeCondition(c, root)).join(' and ');
    case 'or': return cond.conditions.map((c) => describeCondition(c, root)).join(' or ');
    case 'not': return `not (${describeCondition(cond.condition, root)})`;
  }
}

export function workflowToDisplay(nodes: readonly WorkflowStageNode[], root: readonly WorkflowStageNode[] = nodes): DisplayNode[] {
  return nodes.map((n) => {
    const cond = n.runIf === undefined ? undefined : (typeof n.runIf === 'string' ? { op: 'ranOk' as const, ref: n.runIf } : n.runIf);
    const runIfLabel = cond ? `runs only if ${describeCondition(cond, root)}` : undefined;
    if (isWorkflowContainerNode(n)) {
      return {
        id: n.id, name: n.name, optional: n.optional, runIfLabel,
        kindLabel: n.containerType === 'loop' ? LOOP_TYPE_LABELS[n.loopType] : 'Group',
        isContainer: true,
        loopType: n.containerType === 'loop' ? n.loopType : undefined,
        maxIterations: n.containerType === 'loop' ? n.maxIterations : undefined,
        children: workflowToDisplay(n.children, root),
      };
    }
    return {
      id: n.id, name: n.name, optional: n.optional, runIfLabel,
      kindLabel: STAGE_LABELS[n.stage], isContainer: false, children: [],
    };
  });
}

function Dot({ node }: { node: DisplayNode }) {
  const cls = node.optional
    ? 'border-dashed border-amber-500/60 text-amber-400'
    : node.runIfLabel
      ? 'border-solid border-purple-500/60 text-purple-300'
      : node.isContainer
        ? 'border-solid border-sky-500/60 text-sky-300'
        : 'border-solid border-emerald-500/60 text-emerald-300';
  return (
    <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 border-2 bg-[var(--bark-900)] ${cls}`}>
      {node.isContainer && (node.loopType ? <Repeat size={11} /> : <Folder size={11} />)}
    </div>
  );
}

function Row({ node }: { node: DisplayNode }) {
  return (
    <div className="pl-1">
      {node.runIfLabel && (
        <div className="flex items-center gap-1 text-[10px] text-purple-300 mb-0.5 ml-8">
          <CornerDownRight size={10} /> {node.runIfLabel}
        </div>
      )}
      <div className="flex items-center gap-2 py-1">
        <Dot node={node} />
        <span className="text-[10px] uppercase tracking-wide text-slate-500 shrink-0">{node.kindLabel}</span>
        <span className="text-[13px] text-slate-200 truncate">{node.name}</span>
        {node.optional && <span className="text-[10px] text-amber-400 shrink-0">optional</span>}
        {node.isContainer && (node.loopType === 'count' || node.loopType === 'until') && (
          <span className="text-[10px] text-slate-500 shrink-0">×{node.maxIterations ?? '?'}</span>
        )}
      </div>
      {node.children.length > 0 && (
        <div className="ml-3 pl-3 border-l border-[var(--bark-700)]">
          {node.children.map((c) => <Row key={c.id} node={c} />)}
        </div>
      )}
    </div>
  );
}

export function ReadOnlyTree({ nodes }: { nodes: readonly DisplayNode[] }) {
  if (nodes.length === 0) {
    return <p className="text-[12px] text-slate-500 italic">Nothing runs here.</p>;
  }
  return <div>{nodes.map((n) => <Row key={n.id} node={n} />)}</div>;
}

export default ReadOnlyTree;
