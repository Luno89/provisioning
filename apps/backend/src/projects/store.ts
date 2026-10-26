import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Branch, Leaf } from './lib/leaves.js';
import type { Collection, Db } from 'mongodb';
import type { GiteaAccount } from './lib/projects.js';
import type { PartialInfo, ProjectMetadata } from '../platform/index.js';
import type { PlanProposal } from './lib/plan-proposals.js';
import type { SecretRequest, SecretRequestFilter } from './lib/secret-requests.js';
import type { Task } from './lib/tasks.js';
import type { Tree } from './lib/trees.js';
import type { TreeTypeSpec } from './lib/tree-types.js';
import { mergeRecord } from '../platform/lib/merge-record.js';
import { v4 as uuidv4 } from 'uuid';

export interface ProjectsStore extends AreaStore {
  removeProjectRecords(projectId: string): Promise<Record<string, number>>;
  getProjects(): Promise<ProjectMetadata[]>;
  saveProject(project: ProjectMetadata): Promise<void>;
  saveProjectInfo(project: PartialInfo<ProjectMetadata>): Promise<ProjectMetadata>;
  forgetClientFiles(): Promise<number>;
  getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
  saveTreeType(treeType: TreeTypeSpec): Promise<void>;
  deleteTreeType(id: string, ownerId: string): Promise<void>;
  getGiteaAccount(ownerId: string): Promise<GiteaAccount | null>;
  saveGiteaAccount(account: GiteaAccount): Promise<void>;
  getTrees(): Promise<Tree[]>;
  saveTree(tree: Tree): Promise<void>;
  deleteTree(id: string): Promise<void>;
  getBranches(): Promise<Branch[]>;
  saveBranch(branch: Branch): Promise<void>;
  deleteBranch(id: string): Promise<void>;
  getLeaves(): Promise<Leaf[]>;
  saveLeaf(leaf: Leaf): Promise<void>;
  deleteLeaf(id: string): Promise<void>;
  getTasks(ownerId?: string): Promise<Task[]>;
  saveTask(task: Task): Promise<void>;
  deleteTask(id: string): Promise<void>;
  getPlanProposals(ownerId: string, conversationId?: string): Promise<PlanProposal[]>;
  getPlanProposal(ownerId: string, id: string): Promise<PlanProposal | undefined>;
  savePlanProposal(proposal: PlanProposal): Promise<void>;
  deletePlanProposal(ownerId: string, id: string): Promise<void>;
  getSecretRequests(ownerId: string, filter?: SecretRequestFilter): Promise<SecretRequest[]>;
  getSecretRequest(ownerId: string, id: string): Promise<SecretRequest | undefined>;
  saveSecretRequest(request: SecretRequest): Promise<void>;
  deleteSecretRequest(ownerId: string, id: string): Promise<void>;
}

export class MongoProjectsStore implements ProjectsStore {
  constructor(private readonly db: () => Db) {}

  private get branches(): Collection {
    return this.db().collection('branches');
  }

  private get giteaAccounts(): Collection {
    return this.db().collection('giteaAccounts');
  }

  private get leaves(): Collection {
    return this.db().collection('leaves');
  }

  private get planProposals(): Collection {
    return this.db().collection('planProposals');
  }

  private get projects(): Collection {
    return this.db().collection('projects');
  }

  private get secretRequests(): Collection {
    return this.db().collection('secretRequests');
  }

  private get tasks(): Collection {
    return this.db().collection('tasks');
  }

  private get treeTypes(): Collection {
    return this.db().collection('treeTypes');
  }

  private get trees(): Collection {
    return this.db().collection('trees');
  }

  async ensureIndexes(): Promise<void> {
    await this.planProposals.createIndex({ ownerId: 1, conversationId: 1, createdAt: 1 });
    await this.secretRequests.createIndex({ ownerId: 1, projectId: 1, key: 1 });
    try {
      await this.projects.createIndex({ giteaOwner: 1, giteaRepo: 1 }, {
        unique: true,
        partialFilterExpression: { giteaOwner: { $gt: '' }, giteaRepo: { $gt: '' } },
      });
    } catch {
      await this.projects.dropIndex('giteaOwner_1_giteaRepo_1');
      await this.projects.createIndex({ giteaOwner: 1, giteaRepo: 1 }, {
        unique: true,
        partialFilterExpression: { giteaOwner: { $gt: '' }, giteaRepo: { $gt: '' } },
      });
    }
  }

  async getProjects(): Promise<ProjectMetadata[]> {
    return (await this.projects.find({}).toArray()).map(doc => fromDoc<ProjectMetadata>(doc));
  }

  async forgetClientFiles(): Promise<number> {
    return (await this.projects.updateMany({ clientFiles: { $exists: true } }, { $unset: { clientFiles: '' } })).modifiedCount;
  }

  async saveProject(project: ProjectMetadata): Promise<void> {
    const doc = toDoc(project);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.projects.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async saveProjectInfo(project: PartialInfo<ProjectMetadata>): Promise<ProjectMetadata> {
    const id = project.id || uuidv4();
    const previous = (await this.getProjects()).find((x: ProjectMetadata) => x.id === id);
    const merged = mergeRecord(previous, project as Partial<ProjectMetadata>);
    const p: ProjectMetadata = {
      ...merged,

      id: id,
      name: merged.name || '',
      giteaOwner: merged.giteaOwner || '',
      giteaRepo: merged.giteaRepo || '',
      appType: merged.appType || 'gitapp',
      createdAt: merged.createdAt || new Date().toISOString(),
    };
    await this.saveProject(p);
    return p;
  }

  async getTrees(): Promise<Tree[]> {
    return (await this.trees.find({}).toArray()).map(doc => fromDoc<Tree>(doc));
  }

  async saveTree(tree: Tree): Promise<void> {
    const doc = toDoc(tree);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.trees.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async deleteTree(id: string): Promise<void> {
    await this.trees.deleteOne({ _id: id as any });
  }

  async getBranches(): Promise<Branch[]> {
    return (await this.branches.find({}).toArray()).map(doc => fromDoc<Branch>(doc));
  }

  async saveBranch(branch: Branch): Promise<void> {
    const doc = toDoc(branch);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.branches.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async deleteBranch(id: string): Promise<void> {
    await this.branches.deleteOne({ _id: id as any });
  }

  async getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]> {
    const filter = ownerId ? { $or: [{ ownerId }, { ownerId: { $exists: false } }] } : {};
    const docs = await this.treeTypes.find(filter).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as TreeTypeSpec);
  }

  async saveTreeType(treeType: TreeTypeSpec): Promise<void> {
    const { _id: _ignored, ...doc } = treeType as TreeTypeSpec & { _id?: unknown };
    await this.treeTypes.replaceOne(
      { _id: `${treeType.ownerId}:${treeType.id}` } as never,
      doc,
      { upsert: true },
    );
  }

  async deleteTreeType(id: string, ownerId: string): Promise<void> {
    await this.treeTypes.deleteOne({ _id: `${ownerId}:${id}` } as never);
  }

  async getGiteaAccount(ownerId: string): Promise<GiteaAccount | null> {
    const doc = await this.giteaAccounts.findOne({ _id: ownerId as any });
    if (!doc) return null;
    const { _id, ...rest } = doc as any;
    return { ...rest, ownerId: String(_id) } as GiteaAccount;
  }

  async saveGiteaAccount(account: GiteaAccount): Promise<void> {
    const { ownerId, ...rest } = account;
    await this.giteaAccounts.replaceOne({ _id: ownerId as any }, rest, { upsert: true });
  }

  async getLeaves(): Promise<Leaf[]> {
    return (await this.leaves.find({}).toArray()).map(doc => fromDoc<Leaf>(doc));
  }

  async saveLeaf(leaf: Leaf): Promise<void> {
    const doc = toDoc(leaf);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.leaves.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async deleteLeaf(id: string): Promise<void> {
    await this.leaves.deleteOne({ _id: id as any });
  }

  async removeProjectRecords(projectId: string): Promise<Record<string, number>> {
    const removed: Record<string, number> = {};
    for (const name of ['pipelineRuns', 'odooReleases', 'corpus', 'secretRequests', 'pendingApprovals', 'tasks', 'fileShares']) {
      const { deletedCount } = await this.db().collection(name).deleteMany({ projectId });
      if (deletedCount) removed[name] = deletedCount;
    }
    for (const name of ['conversations', 'memories']) {
      const { modifiedCount } = await this.db().collection(name).updateMany({ projectId }, { $unset: { projectId: '' } });
      if (modifiedCount) removed[`${name} unlinked`] = modifiedCount;
    }
    const { deletedCount } = await this.projects.deleteOne({ _id: projectId as never });
    if (deletedCount) removed.projects = deletedCount;
    return removed;
  }

  async getTasks(ownerId?: string): Promise<Task[]> {
    const filter = ownerId ? { ownerId } : {};
    const docs = await this.tasks.find(filter).toArray();
    return docs.map((d: Record<string, unknown>) => fromDoc<Task>(d));
  }

  async saveTask(task: Task): Promise<void> {
    const doc = toDoc(task);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.tasks.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async deleteTask(id: string): Promise<void> {
    await this.tasks.deleteOne({ _id: id as any });
  }

  async getPlanProposals(ownerId: string, conversationId?: string): Promise<PlanProposal[]> {
    const filter = conversationId === undefined ? { ownerId } : { ownerId, conversationId };
    const docs = await this.planProposals.find(filter).sort({ createdAt: 1 }).toArray();
    return docs.map((d: Record<string, unknown>) => fromDoc<PlanProposal>(d));
  }

  async getPlanProposal(ownerId: string, id: string): Promise<PlanProposal | undefined> {
    const doc = await this.planProposals.findOne({ _id: id as any, ownerId });
    return doc ? fromDoc<PlanProposal>(doc as Record<string, unknown>) : undefined;
  }

  async savePlanProposal(proposal: PlanProposal): Promise<void> {
    const doc = toDoc(proposal);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.planProposals.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async deletePlanProposal(ownerId: string, id: string): Promise<void> {
    await this.planProposals.deleteOne({ _id: id as any, ownerId });
  }

  async getSecretRequests(ownerId: string, filter: SecretRequestFilter = {}): Promise<SecretRequest[]> {
    const query: Record<string, unknown> = { ownerId };
    if (filter.conversationId !== undefined) query.conversationId = filter.conversationId;
    if (filter.projectId !== undefined) query.projectId = filter.projectId;
    if (filter.treeId !== undefined) query.treeId = filter.treeId;
    const docs = await this.secretRequests.find(query).sort({ createdAt: 1 }).toArray();
    return docs.map((d: Record<string, unknown>) => fromDoc<SecretRequest>(d));
  }

  async getSecretRequest(ownerId: string, id: string): Promise<SecretRequest | undefined> {
    const doc = await this.secretRequests.findOne({ _id: id as any, ownerId });
    return doc ? fromDoc<SecretRequest>(doc as Record<string, unknown>) : undefined;
  }

  async saveSecretRequest(request: SecretRequest): Promise<void> {
    const doc = toDoc(request);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.secretRequests.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async deleteSecretRequest(ownerId: string, id: string): Promise<void> {
    await this.secretRequests.deleteOne({ _id: id as any, ownerId });
  }
}
