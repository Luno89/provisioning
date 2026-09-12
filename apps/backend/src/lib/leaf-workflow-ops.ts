import { normalizeRunIf, isWorkflowContainerNode, type WorkflowStageNode, type WorkflowCondition } from './leaf-workflow-types.js';
import {
  findNode, parentIdOf, childrenOf, updateNode, removeNode, insertNode, reorderChildren, preOrderNodes,
} from './generic-tree-ops.js';

export function findWorkflowNode(nodes: readonly WorkflowStageNode[], id: string): WorkflowStageNode | undefined {
  return findNode(nodes, id);
}

export function parentIdOfWorkflowNode(nodes: readonly WorkflowStageNode[], id: string, parent: string | null = null): string | null | undefined {
  return parentIdOf(nodes, id, parent);
}

export function childrenOfWorkflowNode(nodes: readonly WorkflowStageNode[], containerId: string | null): WorkflowStageNode[] | undefined {
  return childrenOf(nodes, containerId);
}

export function updateWorkflowNode(nodes: WorkflowStageNode[], id: string, patch: (n: WorkflowStageNode) => WorkflowStageNode): WorkflowStageNode[] {
  return updateNode(nodes, id, patch);
}

export function removeWorkflowNode(nodes: WorkflowStageNode[], id: string): { nodes: WorkflowStageNode[]; removed?: WorkflowStageNode | undefined } {
  return removeNode(nodes, id);
}

export function insertWorkflowNode(nodes: WorkflowStageNode[], parentId: string | null, index: number, node: WorkflowStageNode): WorkflowStageNode[] {
  return insertNode(nodes, parentId, index, node);
}

export function reorderWorkflowChildren(nodes: WorkflowStageNode[], parentId: string | null, orderedIds: readonly string[]): WorkflowStageNode[] | undefined {
  return reorderChildren(nodes, parentId, orderedIds);
}

export function preOrderWorkflowNodes(nodes: readonly WorkflowStageNode[]): WorkflowStageNode[] {
  return preOrderNodes(nodes);
}

function conditionReferencesStage(cond: WorkflowCondition, stageId: string): boolean {
  switch (cond.op) {
    case 'ranOk':
    case 'threw':
      return cond.ref === stageId;
    case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte':
    case 'exists': case 'notExists':
      return cond.path === `stages.${stageId}` || cond.path.startsWith(`stages.${stageId}.`);
    case 'and': case 'or':
      return cond.conditions.some((c) => conditionReferencesStage(c, stageId));
    case 'not':
      return conditionReferencesStage(cond.condition, stageId);
  }
}

export function clearWorkflowStageReferences(nodes: WorkflowStageNode[], removedId: string): WorkflowStageNode[] {
  return nodes.map((n) => {
    const cleared = (n.runIf !== undefined && conditionReferencesStage(normalizeRunIf(n.runIf), removedId))
      ? { ...n, runIf: undefined }
      : n;
    return isWorkflowContainerNode(cleared)
      ? { ...cleared, children: clearWorkflowStageReferences(cleared.children, removedId) }
      : cleared;
  });
}
