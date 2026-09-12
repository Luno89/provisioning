import { isWorkflowContainerNode, type WorkflowStageNode, type WorkflowCondition } from '../shared.js';

export function findNode(nodes: readonly WorkflowStageNode[], id: string): WorkflowStageNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (isWorkflowContainerNode(n)) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function parentIdOf(nodes: readonly WorkflowStageNode[], id: string, parent: string | null = null): string | null | undefined {
  for (const n of nodes) {
    if (n.id === id) return parent;
    if (isWorkflowContainerNode(n)) {
      const found = parentIdOf(n.children, id, n.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function childrenOf(nodes: readonly WorkflowStageNode[], containerId: string | null): WorkflowStageNode[] | undefined {
  if (containerId === null) return [...nodes];
  const found = findNode(nodes, containerId);
  return found && isWorkflowContainerNode(found) ? [...found.children] : undefined;
}

export function updateNode(nodes: WorkflowStageNode[], id: string, patch: (n: WorkflowStageNode) => WorkflowStageNode): WorkflowStageNode[] {
  return nodes.map((n) => {
    if (n.id === id) return patch(n);
    if (isWorkflowContainerNode(n)) return { ...n, children: updateNode(n.children, id, patch) };
    return n;
  });
}

export function removeNode(nodes: WorkflowStageNode[], id: string): { nodes: WorkflowStageNode[]; removed?: WorkflowStageNode | undefined } {
  let removed: WorkflowStageNode | undefined;
  const direct = nodes.filter((n) => {
    if (n.id === id) { removed = n; return false; }
    return true;
  });
  if (removed) return { nodes: direct, removed };

  const next: WorkflowStageNode[] = [];
  for (const n of nodes) {
    if (isWorkflowContainerNode(n)) {
      const res = removeNode(n.children, id);
      if (res.removed) {
        removed = res.removed;
        next.push({ ...n, children: res.nodes });
        continue;
      }
    }
    next.push(n);
  }
  return { nodes: next, removed };
}

export function insertNode(nodes: WorkflowStageNode[], parentId: string | null, index: number, node: WorkflowStageNode): WorkflowStageNode[] {
  if (parentId === null) {
    const next = [...nodes];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, node);
    return next;
  }
  return nodes.map((n) => {
    if (n.id === parentId && isWorkflowContainerNode(n)) {
      const children = [...n.children];
      children.splice(Math.max(0, Math.min(index, children.length)), 0, node);
      return { ...n, children };
    }
    if (isWorkflowContainerNode(n)) return { ...n, children: insertNode(n.children, parentId, index, node) };
    return n;
  });
}

export function moveNode(nodes: WorkflowStageNode[], id: string, toParentId: string | null, toIndex: number): WorkflowStageNode[] {
  const { nodes: without, removed } = removeNode(nodes, id);
  if (!removed) return nodes;
  return insertNode(without, toParentId, toIndex, removed);
}

export function subtreeContainsId(node: WorkflowStageNode, id: string): boolean {
  if (node.id === id) return true;
  return isWorkflowContainerNode(node) && node.children.some((c) => subtreeContainsId(c, id));
}

export function preOrder(nodes: readonly WorkflowStageNode[]): WorkflowStageNode[] {
  const out: WorkflowStageNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (isWorkflowContainerNode(n)) out.push(...preOrder(n.children));
  }
  return out;
}

export function nodesBefore(nodes: readonly WorkflowStageNode[], id: string): WorkflowStageNode[] {
  const order = preOrder(nodes);
  const idx = order.findIndex((n) => n.id === id);
  return idx === -1 ? order : order.slice(0, idx);
}

function normalizeRunIf(runIf: WorkflowCondition | string): WorkflowCondition {
  return typeof runIf === 'string' ? { op: 'ranOk', ref: runIf } : runIf;
}

function conditionReferencesStage(cond: WorkflowCondition, stageId: string): boolean {
  switch (cond.op) {
    case 'ranOk':
    case 'threw':
      return cond.ref === stageId;
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'exists':
    case 'notExists':
      return cond.path === `stages.${stageId}` || cond.path.startsWith(`stages.${stageId}.`);
    case 'and':
    case 'or':
      return cond.conditions.some((c) => conditionReferencesStage(c, stageId));
    case 'not':
      return conditionReferencesStage(cond.condition, stageId);
  }
}

export function clearWorkflowReferences(nodes: WorkflowStageNode[], removedId: string): WorkflowStageNode[] {
  return nodes.map((n) => {
    const cleared = (n.runIf !== undefined && conditionReferencesStage(normalizeRunIf(n.runIf), removedId))
      ? { ...n, runIf: undefined }
      : n;
    return isWorkflowContainerNode(cleared) ? { ...cleared, children: clearWorkflowReferences(cleared.children, removedId) } : cleared;
  });
}
