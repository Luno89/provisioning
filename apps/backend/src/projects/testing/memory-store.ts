import { asStored } from '../../platform/testing/as-stored.js';
import { randomUUID } from 'node:crypto';
import type { PartialInfo, ProjectMetadata } from '../../platform/index.js';
import { mergeRecord } from '../../platform/lib/merge-record.js';
import { copied, MemoryRecords, collectionIn, removeWhere, updateWhere, type Collections } from '../../platform/testing/memory-records.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import type { PlanProposal } from '../lib/plan-proposals.js';
import type { GiteaAccount } from '../lib/projects.js';
import type { SecretRequest, SecretRequestFilter } from '../lib/secret-requests.js';
import type { Task } from '../lib/tasks.js';
import type { Tree } from '../lib/trees.js';
import type { TreeTypeSpec } from '../lib/tree-types.js';
import type { ProjectsStore } from '../store.js';

function stored<T extends { id: string }>(row: T): T {
  const { id, ...rest } = row;
  return { ...asStored(rest), id } as T;
}

const claimedRepository = (project: ProjectMetadata): string | undefined =>
  typeof project.giteaOwner === 'string' && project.giteaOwner > '' && typeof project.giteaRepo === 'string' && project.giteaRepo > ''
    ? JSON.stringify([project.giteaOwner, project.giteaRepo])
    : undefined;

export class MemoryProjectsStore implements ProjectsStore {
  private readonly projects: MemoryRecords<ProjectMetadata>;
  private readonly treeTypes: Map<string, TreeTypeSpec>;
  private readonly giteaAccounts: Map<string, GiteaAccount>;
  private readonly trees: MemoryRecords<Tree>;
  private readonly branches: MemoryRecords<Branch>;
  private readonly leaves: MemoryRecords<Leaf>;
  private readonly tasks: MemoryRecords<Task>;
  private readonly planProposals: MemoryRecords<PlanProposal>;
  private readonly secretRequests: MemoryRecords<SecretRequest>;

  constructor(private readonly collections: Collections = new Map()) {
    this.projects = new MemoryRecords(collectionIn<ProjectMetadata>(collections, 'projects'));
    this.treeTypes = collectionIn<TreeTypeSpec>(collections, 'treeTypes');
    this.giteaAccounts = collectionIn<GiteaAccount>(collections, 'giteaAccounts');
    this.secretRequests = new MemoryRecords(collectionIn<SecretRequest>(collections, 'secretRequests'));
    this.trees = new MemoryRecords(collectionIn<Tree>(collections, 'trees'));
    this.branches = new MemoryRecords(collectionIn<Branch>(collections, 'branches'));
    this.leaves = new MemoryRecords(collectionIn<Leaf>(collections, 'leaves'));
    this.tasks = new MemoryRecords(collectionIn<Task>(collections, 'tasks'));
    this.planProposals = new MemoryRecords(collectionIn<PlanProposal>(collections, 'planProposals'));
  }

  async ensureIndexes(): Promise<void> {}

  async removeProjectRecords(projectId: string): Promise<Record<string, number>> {
    const removed: Record<string, number> = {};
    for (const name of ['pipelineRuns', 'odooReleases', 'corpus', 'secretRequests', 'pendingApprovals', 'tasks']) {
      const deleted = removeWhere(this.collections, name, (row) => row.projectId === projectId);
      if (deleted) removed[name] = deleted;
    }
    for (const name of ['conversations', 'memories']) {
      const modified = updateWhere(this.collections, name, (row) => row.projectId === projectId, (row) => {
        delete row.projectId;
      });
      if (modified) removed[`${name} unlinked`] = modified;
    }
    if (this.projects.delete(projectId)) removed.projects = 1;
    return removed;
  }

  async getProjects(): Promise<ProjectMetadata[]> {
    return this.projects.all();
  }

  async saveProject(project: ProjectMetadata): Promise<void> {
    const repository = claimedRepository(stored(project));
    if (repository !== undefined) {
      const taken = this.projects.all().some((other) => other.id !== project.id && claimedRepository(other) === repository);
      if (taken) throw new Error(`E11000 duplicate key error: giteaOwner_1_giteaRepo_1 dup key: ${repository}`);
    }
    this.projects.put(stored(project));
  }

  async saveProjectInfo(project: PartialInfo<ProjectMetadata>): Promise<ProjectMetadata> {
    const id = project.id || randomUUID();
    const previous = this.projects.get(id);
    const merged = mergeRecord(previous, project as Partial<ProjectMetadata>);
    const next: ProjectMetadata = {
      ...merged,
      id,
      name: merged.name || '',
      giteaOwner: merged.giteaOwner || '',
      giteaRepo: merged.giteaRepo || '',
      appType: merged.appType || 'gitapp',
      createdAt: merged.createdAt || new Date().toISOString(),
    };
    await this.saveProject(next);
    return copied(next);
  }

  async forgetClientFiles(): Promise<number> {
    let forgotten = 0;
    for (const project of this.projects.all()) {
      if (!('clientFiles' in project)) continue;
      delete project.clientFiles;
      this.projects.put(project);
      forgotten += 1;
    }
    return forgotten;
  }

  async getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]> {
    const all = [...this.treeTypes.values()].map(copied);
    return ownerId ? all.filter((type) => type.ownerId === ownerId || !('ownerId' in type)) : all;
  }

  async saveTreeType(treeType: TreeTypeSpec): Promise<void> {
    const { _id: _ignored, ...doc } = treeType as TreeTypeSpec & { _id?: unknown };
    this.treeTypes.set(`${treeType.ownerId}:${treeType.id}`, copied(asStored(doc)));
  }

  async deleteTreeType(id: string, ownerId: string): Promise<void> {
    this.treeTypes.delete(`${ownerId}:${id}`);
  }

  async getGiteaAccount(ownerId: string): Promise<GiteaAccount | null> {
    const account = this.giteaAccounts.get(ownerId);
    return account ? copied(account) : null;
  }

  async saveGiteaAccount(account: GiteaAccount): Promise<void> {
    this.giteaAccounts.set(account.ownerId, copied(asStored(account)));
  }

  async claimGiteaAccount(account: GiteaAccount): Promise<GiteaAccount> {
    if (!this.giteaAccounts.has(account.ownerId)) this.giteaAccounts.set(account.ownerId, copied(asStored(account)));
    return copied(this.giteaAccounts.get(account.ownerId)!);
  }

  async getTrees(): Promise<Tree[]> {
    return this.trees.all();
  }

  async saveTree(tree: Tree): Promise<void> {
    this.trees.put(stored(tree));
  }

  async deleteTree(id: string): Promise<void> {
    this.trees.delete(id);
  }

  async getBranches(): Promise<Branch[]> {
    return this.branches.all();
  }

  async saveBranch(branch: Branch): Promise<void> {
    this.branches.put(stored(branch));
  }

  async deleteBranch(id: string): Promise<void> {
    this.branches.delete(id);
  }

  async getLeaves(): Promise<Leaf[]> {
    return this.leaves.all();
  }

  async saveLeaf(leaf: Leaf): Promise<void> {
    this.leaves.put(stored(leaf));
  }

  async deleteLeaf(id: string): Promise<void> {
    this.leaves.delete(id);
  }

  async getTasks(ownerId?: string): Promise<Task[]> {
    const all = this.tasks.all();
    return ownerId ? all.filter((task) => task.ownerId === ownerId) : all;
  }

  async saveTask(task: Task): Promise<void> {
    this.tasks.put(stored(task));
  }

  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }

  async getPlanProposals(ownerId: string, conversationId?: string): Promise<PlanProposal[]> {
    return this.planProposals
      .all()
      .filter((proposal) => proposal.ownerId === ownerId && (conversationId === undefined || proposal.conversationId === conversationId))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async getPlanProposal(ownerId: string, id: string): Promise<PlanProposal | undefined> {
    const proposal = this.planProposals.get(id);
    return proposal && proposal.ownerId === ownerId ? proposal : undefined;
  }

  async savePlanProposal(proposal: PlanProposal): Promise<void> {
    this.planProposals.put(stored(proposal));
  }

  async deletePlanProposal(ownerId: string, id: string): Promise<void> {
    if (this.planProposals.get(id)?.ownerId === ownerId) this.planProposals.delete(id);
  }

  async getSecretRequests(ownerId: string, filter: SecretRequestFilter = {}): Promise<SecretRequest[]> {
    return this.secretRequests
      .all()
      .filter(
        (request) =>
          request.ownerId === ownerId &&
          (filter.conversationId === undefined || request.conversationId === filter.conversationId) &&
          (filter.projectId === undefined || request.projectId === filter.projectId) &&
          (filter.treeId === undefined || request.treeId === filter.treeId),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async getSecretRequest(ownerId: string, id: string): Promise<SecretRequest | undefined> {
    const request = this.secretRequests.get(id);
    return request && request.ownerId === ownerId ? request : undefined;
  }

  async saveSecretRequest(request: SecretRequest): Promise<void> {
    this.secretRequests.put(stored(request));
  }

  async deleteSecretRequest(ownerId: string, id: string): Promise<void> {
    if (this.secretRequests.get(id)?.ownerId === ownerId) this.secretRequests.delete(id);
  }
}
