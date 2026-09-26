import type { Branch, Leaf } from './leaves.js';
import type { Task } from './tasks.js';
import type { PlanProposal } from './plan-proposals.js';

export type DeletionTarget = { kind: 'tree' | 'branch' | 'leaf'; id: string };

export interface GroveWorld {
  branches: readonly Pick<Branch, 'id' | 'treeId'>[];
  leaves: readonly Pick<Leaf, 'id' | 'branchId'>[];
  tasks: readonly Pick<Task, 'id' | 'leafId'>[];
  proposals: readonly Pick<PlanProposal, 'id' | 'status' | 'conversationId' | 'plan' | 'leafPlan' | 'adopted'>[];
  conversations: readonly { id: string; treeId?: string | undefined }[];
}

export interface DeletionScope {
  treeId?: string | undefined;
  branchIds: string[];
  leafIds: string[];
  taskIds: string[];
  proposalIds: string[];
  adoptingProposalIds: string[];
  conversationIds: string[];
}

export function deletionScope(target: DeletionTarget, world: GroveWorld): DeletionScope {
  const branchIds = target.kind === 'tree'
    ? world.branches.filter((branch) => branch.treeId === target.id).map((branch) => branch.id)
    : target.kind === 'branch' ? [target.id] : [];
  const branchSet = new Set(branchIds);
  const leafIds = target.kind === 'leaf'
    ? [target.id]
    : world.leaves.filter((leaf) => branchSet.has(leaf.branchId)).map((leaf) => leaf.id);
  const leafSet = new Set(leafIds);

  const conversationIds = target.kind === 'tree'
    ? world.conversations.filter((conversation) => conversation.treeId === target.id).map((conversation) => conversation.id)
    : [];
  const conversationSet = new Set(conversationIds);

  const proposals = world.proposals.filter((proposal) => {
    if (proposal.leafPlan && leafSet.has(proposal.leafPlan.leafId)) return true;
    if (target.kind !== 'tree') return false;
    return proposal.plan?.treeId === target.id
      || proposal.leafPlan?.treeId === target.id
      || proposal.adopted?.treeId === target.id
      || (proposal.conversationId !== undefined && conversationSet.has(proposal.conversationId));
  });

  return {
    ...(target.kind === 'tree' ? { treeId: target.id } : {}),
    branchIds,
    leafIds,
    taskIds: world.tasks.filter((task) => task.leafId && leafSet.has(task.leafId)).map((task) => task.id),
    proposalIds: proposals.map((proposal) => proposal.id),
    adoptingProposalIds: proposals.filter((proposal) => proposal.status === 'adopting').map((proposal) => proposal.id),
    conversationIds,
  };
}
