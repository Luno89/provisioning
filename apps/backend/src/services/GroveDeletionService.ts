import { deletionScope, type DeletionScope, type DeletionTarget } from '../lib/grove-deletion.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import type { Task } from '../engine-host/tools/tasks.js';
import type { Tree } from '../lib/trees.js';
import type { PlanProposal } from '../lib/plan-proposals.js';
import type { Conversation } from '../lib/conversations.js';
import { groveRunWorkflowId } from '../engine-host/temporal/contracts.js';

export interface GroveDeletionStore {
  getTrees(): Promise<Tree[]>;
  getBranches(): Promise<Branch[]>;
  getLeaves(): Promise<Leaf[]>;
  getTasks(ownerId?: string): Promise<Task[]>;
  getPlanProposals(ownerId: string): Promise<PlanProposal[]>;
  getConversations(): Promise<Conversation[]>;
  deleteTree(id: string): Promise<void>;
  deleteBranch(id: string): Promise<void>;
  deleteLeaf(id: string): Promise<void>;
  deleteTask(id: string): Promise<void>;
  deletePlanProposal(ownerId: string, id: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
}

export interface GroveDeletionDeps {
  store: GroveDeletionStore;
  workflows: { terminate(workflowId: string, reason: string): Promise<boolean> };
  workspaces: { release(treeId: string): Promise<void> };
}

export type GroveDeletion =
  | { ok: true; value: { scope: DeletionScope; stoppedRun: boolean } }
  | { ok: false; status: 404; error: string };

export const adoptionWorkflowId = (proposalId: string): string => `adopt-plan-${proposalId}`;

export class GroveDeletionService {
  constructor(private readonly deps: GroveDeletionDeps) {}

  async deleteTree(ownerId: string, treeId: string): Promise<GroveDeletion> {
    const tree = (await this.deps.store.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
    if (!tree) return { ok: false, status: 404, error: 'Tree not found' };
    return this.remove(ownerId, { kind: 'tree', id: tree.id }, tree.id);
  }

  async deleteBranch(ownerId: string, branchId: string): Promise<GroveDeletion> {
    const branch = (await this.deps.store.getBranches()).find((entry) => entry.id === branchId && entry.ownerId === ownerId);
    if (!branch) return { ok: false, status: 404, error: 'Branch not found' };
    return this.remove(ownerId, { kind: 'branch', id: branch.id }, branch.treeId);
  }

  async deleteLeaf(ownerId: string, leafId: string): Promise<GroveDeletion> {
    const leaf = (await this.deps.store.getLeaves()).find((entry) => entry.id === leafId && entry.ownerId === ownerId);
    if (!leaf) return { ok: false, status: 404, error: 'Leaf not found' };
    const treeId = (await this.deps.store.getBranches()).find((branch) => branch.id === leaf.branchId)?.treeId;
    return this.remove(ownerId, { kind: 'leaf', id: leaf.id }, treeId);
  }

  private async remove(ownerId: string, target: DeletionTarget, treeId: string | undefined): Promise<GroveDeletion> {
    const { store } = this.deps;
    const scope = deletionScope(target, {
      branches: (await store.getBranches()).filter((branch) => branch.ownerId === ownerId),
      leaves: (await store.getLeaves()).filter((leaf) => leaf.ownerId === ownerId),
      tasks: await store.getTasks(ownerId),
      proposals: await store.getPlanProposals(ownerId),
      conversations: (await store.getConversations()).filter((conversation) => conversation.ownerId === ownerId),
    });

    const reason = `${target.kind} ${target.id} was deleted`;
    const stoppedRun = treeId ? await this.deps.workflows.terminate(groveRunWorkflowId(treeId), reason) : false;
    for (const id of scope.adoptingProposalIds) await this.deps.workflows.terminate(adoptionWorkflowId(id), reason);

    for (const id of scope.taskIds) await store.deleteTask(id);
    for (const id of scope.leafIds) await store.deleteLeaf(id);
    for (const id of scope.proposalIds) await store.deletePlanProposal(ownerId, id);
    for (const id of scope.conversationIds) await store.deleteConversation(id);
    for (const id of scope.branchIds) await store.deleteBranch(id);
    if (scope.treeId) {
      await this.deps.workspaces.release(scope.treeId);
      await store.deleteTree(scope.treeId);
    }
    return { ok: true, value: { scope, stoppedRun } };
  }
}
