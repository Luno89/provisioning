import type { Persona } from '@koala/harness-types';
import { MongoClient, type Db, type Collection, ObjectId } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { mergeRecord } from './merge-record.js';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, UserMetadata, ProjectMetadata, PipelineRunMetadata, InviteMetadata, ModelEndpointMetadata } from './types.js';
import type { Database, PartialInfo } from './db-interface.js';
import type { Branch, Leaf } from './leaves.js';
import type { Tree } from './trees.js';
import type { CorpusPage } from './corpus.js';
import type { GiteaAccount } from './projects.js';
import type { Experiment } from './experiments.js';
import type { HarnessProfile } from './harness-profile.js';
import type { MemoryItem } from './memory-store.js';
import { TOOL_REPOSITORY, type ToolRepositoryItem } from './tool-repository.js';
import type { ModelThinkingProfile } from './thinking-classifier.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin';

function toBsonId(id: string): ObjectId | string {
  if (ObjectId.isValid(id)) return new ObjectId(id);
  return id;
}

function fromDoc<T extends { id: string }>(doc: Record<string, any> | null | undefined): T {
  if (!doc) return null as any;
  const result = { ...doc };
  if (result._id !== undefined && result._id !== null) {
    result.id = typeof result._id === 'object' && typeof result._id.toString === 'function'
      ? result._id.toString()
      : String(result._id);
  } else if (!result.id) {
    result.id = '';
  }
  const { _id, ...rest } = result;
  return rest as T;
}

function toDoc<T extends { id: string }>(entity: T): Record<string, any> {
  const { id, ...rest } = entity as any;
  return {
    ...rest,
    _id: id,
  };
}

export class MongoDB implements Database {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  private get clusters(): Collection {
    return this.db!.collection('clusters');
  }

  private get deployments(): Collection {
    return this.db!.collection('deployments');
  }

  private get users(): Collection {
    return this.db!.collection('users');
  }

  private get pipelineRuns(): Collection {
    return this.db!.collection('pipelineRuns');
  }

  private get projects(): Collection {
    return this.db!.collection('projects');
  }

  private get experiments(): Collection {
    return this.db!.collection('experiments');
  }

  private get personas(): Collection {
    return this.db!.collection('personas');
  }

  private get harnessProfiles(): Collection {
    return this.db!.collection('harnessProfiles');
  }

  private get giteaAccounts(): Collection {
    return this.db!.collection('giteaAccounts');
  }

  private get corpus(): Collection {
    return this.db!.collection('corpus');
  }

  private get trees(): Collection {
    return this.db!.collection('trees');
  }

  private get branches(): Collection {
    return this.db!.collection('branches');
  }

  private get leaves(): Collection {
    return this.db!.collection('leaves');
  }

  private get modelEndpoints(): Collection {
    return this.db!.collection('modelEndpoints');
  }

  private get invites(): Collection {
    return this.db!.collection('invites');
  }

  private get memories(): Collection {
    return this.db!.collection('memories');
  }

  private get tools(): Collection {
    return this.db!.collection('tools');
  }

  private get thinkingProfiles(): Collection {
    return this.db!.collection('model_thinking_profiles');
  }

  async init(): Promise<void> {
    const isE2E = process.env.IS_E2E === 'true';
    const uri = isE2E
      ? (process.env.MONGO_TEST_URI || MONGO_URI.replace('/provisioning', '/provisioning_test'))
      : MONGO_URI;

    this.client = new MongoClient(uri);
    await this.client.connect();
    this.db = this.client.db(isE2E ? 'provisioning_test' : 'provisioning');

    if (isE2E) {
      await this.db.dropDatabase();
    }

    await this.clusters.createIndex({ name: 1 }, { unique: true });
    await this.deployments.createIndex({ clusterId: 1 });
    await this.deployments.createIndex({ name: 1 }, { unique: true });
    await this.users.createIndex({ email: 1 }, { unique: true });
    await this.projects.createIndex({ giteaOwner: 1, giteaRepo: 1 }, { unique: true });
    await this.pipelineRuns.createIndex({ projectId: 1 });
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  async getClusters(): Promise<ClusterMetadata[]> {
    return (await this.clusters.find({}).toArray()).map(doc => fromDoc<ClusterMetadata>(doc));
  }

  async saveCluster(cluster: ClusterMetadata): Promise<void> {
    const doc = toDoc(cluster);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.clusters.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async saveClusterList(clusters: ClusterMetadata[]): Promise<void> {
    await this.clusters.deleteMany({});
    if (clusters.length > 0) {
      await this.clusters.insertMany(clusters.map(toDoc));
    }
  }

  async saveClusterInfo(cluster: PartialInfo<ClusterMetadata>): Promise<ClusterMetadata> {
    const id = cluster.id || uuidv4();
    /**
     * Merged onto the stored record, not rebuilt from a list of fields.
     *
     * The list this replaced dropped anything it did not name — see lib/merge-record.ts
     * for the two times that lost real data. Absence now means unchanged, which is what
     * "save this partial info" already promised.
     */
    const previous = (await this.getClusters()).find((x: ClusterMetadata) => x.id === id);
    const merged = mergeRecord(previous, cluster as Partial<ClusterMetadata>);
    const c: ClusterMetadata = {
      ...merged,

      id: id,
      name: merged.name || '',
      provider: merged.provider || 'k3d',
      status: merged.status || 'provisioning',
    };
    await this.saveCluster(c);
    return c;
  }

  async updateClusterProgress(clusterId: string, progress: ClusterProgress): Promise<void> {
    await this.clusters.updateOne(
      { _id: clusterId as any },
      { $set: { progress } }
    );
  }

  async getDeployments(): Promise<DeploymentMetadata[]> {
    return (await this.deployments.find({}).toArray()).map(doc => fromDoc<DeploymentMetadata>(doc));
  }

  async saveDeployment(deployment: DeploymentMetadata): Promise<void> {
    const doc = toDoc(deployment);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.deployments.replaceOne({ _id: id }, filter, { upsert: true });
  }

  /**
   * Reconciles the collection to this list, without ever emptying it first.
   *
   * ── WHY NOT deleteMany + insertMany ──
   * That is what this was, and it has two failure modes that both bite in the destroy → deploy
   * cycle. It is not atomic, so anything writing between the two steps — the 30-second reconcile
   * loop, a deploy, an exposure sync — inserts a document that `insertMany` then collides with:
   * `E11000 duplicate key ... index: _id_`, observed on exactly this path.
   *
   * The second is worse and silent. `deleteMany({})` had already succeeded when `insertMany` threw,
   * so a failure did not leave the collection unchanged — it left it EMPTY. One racing write could
   * therefore delete every deployment record for every user, and the only trace was a warning line
   * in the reconcile log.
   *
   * A bulk upsert plus targeted deletes has neither property: nothing is removed that the caller
   * did not omit, a concurrent insert is absorbed rather than collided with, and a failure leaves
   * the collection as it was.
   */
  async saveDeploymentList(deployments: DeploymentMetadata[]): Promise<void> {
    const keep = deployments.map(toDoc);
    const keepIds = keep.map((d) => d._id);

    const ops: any[] = keep.map((doc) => {
      const { _id, ...rest } = doc;
      return { replaceOne: { filter: { _id }, replacement: rest, upsert: true } };
    });
    // Removals are expressed as "anything not in the list" rather than "empty it and rebuild",
    // so the window in which the collection is missing records never exists.
    ops.push({ deleteMany: { filter: keepIds.length ? { _id: { $nin: keepIds } } : {} } });

    await this.deployments.bulkWrite(ops, { ordered: false });
  }

  /** Removes one deployment. What every "filter it out and rewrite the world" caller actually meant. */
  async deleteDeployment(id: string): Promise<void> {
    await this.deployments.deleteOne({ _id: id as any });
  }

  async saveDeploymentInfo(deployment: PartialInfo<DeploymentMetadata>): Promise<DeploymentMetadata> {
    const id = deployment.id || uuidv4();
    /**
     * Merged onto the stored record, not rebuilt from a list of fields.
     *
     * The list this replaced dropped anything it did not name — see lib/merge-record.ts
     * for the two times that lost real data. Absence now means unchanged, which is what
     * "save this partial info" already promised.
     */
    const previous = (await this.getDeployments()).find((x: DeploymentMetadata) => x.id === id);
    const merged = mergeRecord(previous, deployment as Partial<DeploymentMetadata>);
    const d: DeploymentMetadata = {
      ...merged,

      id: id,
      name: merged.name || '',
      clusterId: merged.clusterId || '',
      strategy: merged.strategy || 'helm',
      status: merged.status || 'deploying',
    };
    await this.saveDeployment(d);
    return d;
  }

  async getProjects(): Promise<ProjectMetadata[]> {
    return (await this.projects.find({}).toArray()).map(doc => fromDoc<ProjectMetadata>(doc));
  }

  async saveProject(project: ProjectMetadata): Promise<void> {
    const doc = toDoc(project);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.projects.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async saveProjectInfo(project: PartialInfo<ProjectMetadata>): Promise<ProjectMetadata> {
    const id = project.id || uuidv4();
    /**
     * Merged onto the stored record, not rebuilt from a list of fields.
     *
     * The list this replaced dropped anything it did not name — see lib/merge-record.ts
     * for the two times that lost real data. Absence now means unchanged, which is what
     * "save this partial info" already promised.
     */
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

  async getPipelineRuns(): Promise<PipelineRunMetadata[]> {
    return (await this.pipelineRuns.find({}).toArray()).map(doc => fromDoc<PipelineRunMetadata>(doc));
  }

  async savePipelineRun(run: PipelineRunMetadata): Promise<void> {
    const doc = toDoc(run);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.pipelineRuns.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async savePipelineRunInfo(run: PartialInfo<PipelineRunMetadata>): Promise<PipelineRunMetadata> {
    const id = run.id || uuidv4();
    /**
     * Merged onto the stored record, not rebuilt from a list of fields.
     *
     * The list this replaced dropped anything it did not name — see lib/merge-record.ts
     * for the two times that lost real data. Absence now means unchanged, which is what
     * "save this partial info" already promised.
     */
    const previous = (await this.getPipelineRuns()).find((x: PipelineRunMetadata) => x.id === id);
    const merged = mergeRecord(previous, run as Partial<PipelineRunMetadata>);
    const r: PipelineRunMetadata = {
      ...merged,

      id: id,
      projectId: merged.projectId || '',
      commitSha: merged.commitSha || '',
      ref: merged.ref || '',
      status: merged.status || 'queued',
      startedAt: merged.startedAt || new Date().toISOString(),
    };
    await this.savePipelineRun(r);
    return r;
  }

  async getInvites(): Promise<InviteMetadata[]> {
    return (await this.invites.find({}).toArray()).map(doc => fromDoc<InviteMetadata>(doc));
  }

  async saveInvite(invite: InviteMetadata): Promise<void> {
    const doc = toDoc(invite);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.invites.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async getCorpusPages(filter: { ownerId: string; ingestId?: string; projectId?: string }): Promise<CorpusPage[]> {
    const query: Record<string, unknown> = { ownerId: filter.ownerId };
    if (filter.ingestId) query.ingestId = filter.ingestId;
    if (filter.projectId) query.projectId = filter.projectId;
    return (await this.corpus.find(query).toArray()).map(doc => fromDoc<CorpusPage>(doc));
  }

  async saveCorpusPages(pages: CorpusPage[]): Promise<void> {
    if (!pages.length) return;
    // One round trip for a whole crawl batch. Written one-by-one this is the slowest part of an
    // ingest by an order of magnitude.
    await this.corpus.bulkWrite(pages.map((page) => {
      const doc = toDoc(page);
      const { _id, ...rest } = doc;
      return { replaceOne: { filter: { _id }, replacement: rest, upsert: true } };
    }));
  }

  async deleteCorpus(ingestId: string): Promise<void> {
    await this.corpus.deleteMany({ ingestId });
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

  /** Keyed by ownerId rather than a surrogate id — there is exactly one account per user, and a
   *  second one would mean a user whose repos are split across two identities. */
  async getExperiments(): Promise<Experiment[]> {
    return (await this.experiments.find({}).toArray()).map(doc => fromDoc<Experiment>(doc));
  }

  async saveExperiment(experiment: Experiment): Promise<void> {
    const doc = toDoc(experiment);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.experiments.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async deleteExperiment(id: string): Promise<void> {
    await this.experiments.deleteOne({ _id: id as any });
  }

  /** Keyed by its own id, unlike the profile: a user has several personas, not one. */
  async getPersonas(): Promise<Persona[]> {
    return (await this.personas.find({}).toArray()).map(doc => fromDoc<Persona>(doc));
  }

  async savePersona(persona: Persona): Promise<void> {
    const doc = toDoc(persona);
    const id = doc._id;
    delete (doc as any)._id;
    await this.personas.replaceOne({ _id: id }, doc, { upsert: true });
  }

  async deletePersona(id: string): Promise<void> {
    await this.personas.deleteOne({ _id: id as any });
  }

  /** Keyed by ownerId, like the Gitea account above — one profile in force per user. */
  async getHarnessProfile(ownerId: string): Promise<HarnessProfile | null> {
    const doc = await this.harnessProfiles.findOne({ _id: ownerId as any });
    if (!doc) return null;
    const { _id, ...rest } = doc as any;
    return { ...rest, ownerId: String(_id) } as HarnessProfile;
  }

  async saveHarnessProfile(profile: HarnessProfile): Promise<void> {
    const { ownerId, ...rest } = profile;
    await this.harnessProfiles.replaceOne({ _id: ownerId as any }, rest, { upsert: true });
  }

  async deleteHarnessProfile(ownerId: string): Promise<void> {
    await this.harnessProfiles.deleteOne({ _id: ownerId as any });
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
    // Collections here are untyped, so _id infers as ObjectId; every id in this codebase is a uuid.
    await this.leaves.deleteOne({ _id: id as any });
  }

  async getModelEndpoints(): Promise<ModelEndpointMetadata[]> {
    return (await this.modelEndpoints.find({}).toArray()).map(doc => fromDoc<ModelEndpointMetadata>(doc));
  }

  async saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void> {
    const doc = toDoc(endpoint);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.modelEndpoints.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async deleteModelEndpoint(id: string): Promise<void> {
    // Collections here are untyped, so `_id` is inferred as ObjectId. Every id in this codebase is
    // a uuid string (see toDoc) — the other methods get away without a cast only because they pass
    // `doc._id`, which toDoc widens to any.
    await this.modelEndpoints.deleteOne({ _id: id as any });
  }

  async getUsers(): Promise<UserMetadata[]> {
    return (await this.users.find({}).toArray()).map(doc => fromDoc<UserMetadata>(doc));
  }

  async saveUser(user: UserMetadata): Promise<void> {
    const doc = toDoc(user);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.users.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async saveUserList(users: UserMetadata[]): Promise<void> {
    await this.users.deleteMany({});
    if (users.length > 0) {
      await this.users.insertMany(users.map(toDoc));
    }
  }

  async getUserByEmail(email: string): Promise<UserMetadata | undefined> {
    const doc = await this.users.findOne({ email: email.trim().toLowerCase() });
    return doc ? fromDoc<UserMetadata>(doc) : undefined;
  }

  async getUserById(id: string): Promise<UserMetadata | undefined> {
    const doc = await this.users.findOne({ _id: id as any });
    return doc ? fromDoc<UserMetadata>(doc) : undefined;
  }

  async getMemories(ownerId?: string): Promise<MemoryItem[]> {
    const filter = ownerId ? { ownerId } : {};
    const docs = await this.memories.find(filter).toArray();
    return docs.map((d) => fromDoc<MemoryItem>(d));
  }

  async saveMemory(memory: MemoryItem): Promise<void> {
    const doc = toDoc(memory);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.memories.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async deleteMemory(id: string): Promise<void> {
    await this.memories.deleteOne({ _id: id as any });
  }

  async getTools(): Promise<ToolRepositoryItem[]> {
    const builtIns = TOOL_REPOSITORY.map((t) => ({ ...t, isBuiltIn: true }));
    const customDocs = await this.tools.find({}).toArray();
    const customItems = customDocs.map((d) => fromDoc<ToolRepositoryItem>(d));
    const customMap = new Map(customItems.map((t) => [t.id, t]));
    
    const result = builtIns.map((t) => customMap.get(t.id) ?? t);
    for (const c of customItems) {
      if (!result.some((r) => r.id === c.id)) {
        result.push(c);
      }
    }
    return result;
  }

  async saveTool(tool: ToolRepositoryItem): Promise<void> {
    const doc = toDoc(tool);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.tools.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async deleteTool(id: string): Promise<void> {
    await this.tools.deleteOne({ _id: id as any });
  }

  async getModelThinkingProfile(modelId: string): Promise<ModelThinkingProfile | null> {
    const doc = await this.thinkingProfiles.findOne({ modelId });
    return doc ? fromDoc<ModelThinkingProfile>(doc) : null;
  }

  async saveModelThinkingProfile(profile: ModelThinkingProfile): Promise<void> {
    const doc = toDoc(profile);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.thinkingProfiles.replaceOne({ modelId: profile.modelId }, filter, { upsert: true });
  }
}