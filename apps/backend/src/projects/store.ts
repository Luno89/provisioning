import { type AreaStore, type Identified, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Branch, Leaf } from './lib/leaves.js';
import type { Collection, Db, Document } from 'mongodb';
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
  claimGiteaAccount(account: GiteaAccount): Promise<GiteaAccount>;
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

type Stored = Document & { _id: string };

async function put(collection: Collection<Stored>, entity: Identified): Promise<void> {
  const { _id, ...rest } = toDoc(entity);
  await collection.replaceOne({ _id: entity.id }, rest, { upsert: true });
}

export class MongoProjectsStore implements ProjectsStore {
  constructor(private readonly db: () => Db) {}

  private get branches(): Collection<Stored> {
    return this.db().collection<Stored>('branches');
  }

  private get giteaAccounts(): Collection<Stored> {
    return this.db().collection<Stored>('giteaAccounts');
  }

  private get leaves(): Collection<Stored> {
    return this.db().collection<Stored>('leaves');
  }

  private get planProposals(): Collection<Stored> {
    return this.db().collection<Stored>('planProposals');
  }

  private get projects(): Collection<Stored> {
    return this.db().collection<Stored>('projects');
  }

  private get secretRequests(): Collection<Stored> {
    return this.db().collection<Stored>('secretRequests');
  }

  private get tasks(): Collection<Stored> {
    return this.db().collection<Stored>('tasks');
  }

  private get treeTypes(): Collection<Stored> {
    return this.db().collection<Stored>('treeTypes');
  }

  private get trees(): Collection<Stored> {
    return this.db().collection<Stored>('trees');
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
    await put(this.projects, project);
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
    await put(this.trees, tree);
  }

  async deleteTree(id: string): Promise<void> {
    await this.trees.deleteOne({ _id: id });
  }

  async getBranches(): Promise<Branch[]> {
    return (await this.branches.find({}).toArray()).map(doc => fromDoc<Branch>(doc));
  }

  async saveBranch(branch: Branch): Promise<void> {
    await put(this.branches, branch);
  }

  async deleteBranch(id: string): Promise<void> {
    await this.branches.deleteOne({ _id: id });
  }

  async getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]> {
    const filter = ownerId ? { $or: [{ ownerId }, { ownerId: { $exists: false } }] } : {};
    const docs = await this.treeTypes.find(filter).toArray();
    return docs.map(({ _id, ...rest }) => rest as TreeTypeSpec);
  }

  async saveTreeType(treeType: TreeTypeSpec): Promise<void> {
    const { _id: _ignored, ...doc } = treeType as TreeTypeSpec & { _id?: unknown };
    await this.treeTypes.replaceOne(
      { _id: `${treeType.ownerId}:${treeType.id}` },
      doc,
      { upsert: true },
    );
  }

  async deleteTreeType(id: string, ownerId: string): Promise<void> {
    await this.treeTypes.deleteOne({ _id: `${ownerId}:${id}` });
  }

  async getGiteaAccount(ownerId: string): Promise<GiteaAccount | null> {
    const doc = await this.giteaAccounts.findOne({ _id: ownerId });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return { ...rest, ownerId: _id } as GiteaAccount;
  }

  async saveGiteaAccount(account: GiteaAccount): Promise<void> {
    const { ownerId, ...rest } = account;
    await this.giteaAccounts.replaceOne({ _id: ownerId }, rest, { upsert: true });
  }

  async claimGiteaAccount(account: GiteaAccount): Promise<GiteaAccount> {
    const { ownerId, ...rest } = account;
    const doc = await this.giteaAccounts.findOneAndUpdate({ _id: ownerId }, { $setOnInsert: rest }, { upsert: true, returnDocument: 'after' });
    if (!doc) throw new Error(`Mongo kept no Gitea account for ${ownerId} after claiming it`);
    const { _id, ...stored } = doc;
    return { ...stored, ownerId: _id } as GiteaAccount;
  }

  async getLeaves(): Promise<Leaf[]> {
    return (await this.leaves.find({}).toArray()).map(doc => fromDoc<Leaf>(doc));
  }

  async saveLeaf(leaf: Leaf): Promise<void> {
    await put(this.leaves, leaf);
  }

  async deleteLeaf(id: string): Promise<void> {
    await this.leaves.deleteOne({ _id: id });
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
    const { deletedCount } = await this.projects.deleteOne({ _id: projectId });
    if (deletedCount) removed.projects = deletedCount;
    return removed;
  }

  async getTasks(ownerId?: string): Promise<Task[]> {
    const filter = ownerId ? { ownerId } : {};
    const docs = await this.tasks.find(filter).toArray();
    return docs.map((d) => fromDoc<Task>(d));
  }

  async saveTask(task: Task): Promise<void> {
    await put(this.tasks, task);
  }

  async deleteTask(id: string): Promise<void> {
    await this.tasks.deleteOne({ _id: id });
  }

  async getPlanProposals(ownerId: string, conversationId?: string): Promise<PlanProposal[]> {
    const filter = conversationId === undefined ? { ownerId } : { ownerId, conversationId };
    const docs = await this.planProposals.find(filter).sort({ createdAt: 1 }).toArray();
    return docs.map((d) => fromDoc<PlanProposal>(d));
  }

  async getPlanProposal(ownerId: string, id: string): Promise<PlanProposal | undefined> {
    const doc = await this.planProposals.findOne({ _id: id, ownerId });
    return doc ? fromDoc<PlanProposal>(doc) : undefined;
  }

  async savePlanProposal(proposal: PlanProposal): Promise<void> {
    await put(this.planProposals, proposal);
  }

  async deletePlanProposal(ownerId: string, id: string): Promise<void> {
    await this.planProposals.deleteOne({ _id: id, ownerId });
  }

  async getSecretRequests(ownerId: string, filter: SecretRequestFilter = {}): Promise<SecretRequest[]> {
    const query: Record<string, unknown> = { ownerId };
    if (filter.conversationId !== undefined) query.conversationId = filter.conversationId;
    if (filter.projectId !== undefined) query.projectId = filter.projectId;
    if (filter.treeId !== undefined) query.treeId = filter.treeId;
    const docs = await this.secretRequests.find(query).sort({ createdAt: 1 }).toArray();
    return docs.map((d) => fromDoc<SecretRequest>(d));
  }

  async getSecretRequest(ownerId: string, id: string): Promise<SecretRequest | undefined> {
    const doc = await this.secretRequests.findOne({ _id: id, ownerId });
    return doc ? fromDoc<SecretRequest>(doc) : undefined;
  }

  async saveSecretRequest(request: SecretRequest): Promise<void> {
    await put(this.secretRequests, request);
  }

  async deleteSecretRequest(ownerId: string, id: string): Promise<void> {
    await this.secretRequests.deleteOne({ _id: id, ownerId });
  }
}
