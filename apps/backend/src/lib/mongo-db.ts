import type { Persona, PersonaPack } from '@koala/harness-types';
import type { Conversation } from './conversations.js';
import type { StoredAppSpec } from './app-spec.js';
import { MongoClient, type Db, type Collection, ObjectId } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { mergeRecord } from './merge-record.js';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, UserMetadata, ProjectMetadata, PipelineRunMetadata, InviteMetadata, ModelEndpointMetadata } from './types.js';
import type { Database, PartialInfo, BindingTypeRecord } from './db-interface.js';
import type { Branch, Leaf } from './leaves.js';
import type { Tree } from './trees.js';
import type { CorpusPage } from './corpus.js';
import { frontierOrder, type FrontierUrl, type FrontierClaim } from './frontier.js';
import type { LeafTrace, LeafEvidence } from './leaf-trace.js';
import type { AgentStep } from '@koala/harness-types';
import type { GiteaAccount } from './projects.js';
import type { Experiment } from './experiments.js';
import type { HarnessProfile } from './harness-profile.js';
import type { MemoryItem } from './memory-store.js';
import type { TreeTypeSpec } from './tree-types.js';
import type { ToolRepositoryItem } from './tool-repository.js';
import type { ModelThinkingProfile } from './thinking-classifier.js';
import type { ClusterProviderSpec } from './cluster-providers.js';

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

  private get personaPacks(): Collection {
    return this.db!.collection('personaPacks');
  }

  private get treeTypes(): Collection {
    return this.db!.collection('treeTypes');
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

  private get frontier(): Collection {
    return this.db!.collection('crawl_frontier');
  }

  private get leafTraces(): Collection {
    return this.db!.collection('leaf_traces');
  }

  private get trees(): Collection {
    return this.db!.collection('trees');
  }

  private get branches(): Collection {
    return this.db!.collection('branches');
  }

  private get appSpecs(): Collection {
    return this.db!.collection('appSpecs');
  }

  private get clusterProviders(): Collection {
    return this.db!.collection('clusterProviders');
  }

  private get conversations(): Collection {
    return this.db!.collection('conversations');
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

  private get bindingTypes(): Collection {
    return this.db!.collection('bindingTypes');
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
    await this.frontier.createIndex({ ingestId: 1, state: 1, depth: 1, rank: -1, url: 1 });
    await this.corpus.createIndex({ ownerId: 1, ingestId: 1 });
    await this.corpus.createIndex({ ownerId: 1, projectId: 1 });
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

  async saveDeploymentList(deployments: DeploymentMetadata[]): Promise<void> {
    const keep = deployments.map(toDoc);
    const keepIds = keep.map((d) => d._id);

    const ops: any[] = keep.map((doc) => {
      const { _id, ...rest } = doc;
      return { replaceOne: { filter: { _id }, replacement: rest, upsert: true } };
    });
    ops.push({ deleteMany: { filter: keepIds.length ? { _id: { $nin: keepIds } } : {} } });

    await this.deployments.bulkWrite(ops, { ordered: false });
  }

  async deleteDeployment(id: string): Promise<void> {
    await this.deployments.deleteOne({ _id: id as any });
  }

  async saveDeploymentInfo(deployment: PartialInfo<DeploymentMetadata>): Promise<DeploymentMetadata> {
    const id = deployment.id || uuidv4();
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
    await this.corpus.bulkWrite(pages.map((page) => {
      const doc = toDoc(page);
      const { _id, ...rest } = doc;
      return { replaceOne: { filter: { _id }, replacement: rest, upsert: true } };
    }));
  }

  async deleteCorpus(ingestId: string): Promise<void> {
    await this.corpus.deleteMany({ ingestId });
  }

  async enqueueFrontier(urls: FrontierUrl[]): Promise<number> {
    if (!urls.length) return 0;
    try {
      const res = await this.frontier.insertMany(
        urls.map((u) => { const { _id, ...rest } = toDoc(u); return { _id, ...rest }; }),
        { ordered: false },
      );
      return res.insertedCount;
    } catch (err: any) {
      if (err?.code === 11000 || err?.writeErrors) return err.result?.insertedCount ?? err.insertedCount ?? 0;
      throw err;
    }
  }

  async claimFrontier(ingestId: string, limit: number): Promise<FrontierClaim[]> {
    if (limit <= 0) return [];
    const docs = await this.frontier
      .find({ ingestId, state: 'pending' })
      .sort({ depth: 1, rank: -1, url: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => ({ url: String(d.url), depth: Number(d.depth) }));
  }

  async completeFrontier(ingestId: string, urls: string[]): Promise<void> {
    if (!urls.length) return;
    await this.frontier.updateMany({ ingestId, url: { $in: urls } }, { $set: { state: 'done' } });
  }

  async countFrontier(ingestId: string): Promise<number> {
    return this.frontier.countDocuments({ ingestId, state: 'pending' });
  }

  async deleteFrontier(ingestId: string): Promise<void> {
    await this.frontier.deleteMany({ ingestId });
  }

  async getLeafTrace(leafId: string): Promise<LeafTrace | null> {
    const doc = await this.leafTraces.findOne({ _id: leafId as any });
    return doc ? fromDoc<LeafTrace>(doc) : null;
  }

  async saveLeafTrace(trace: LeafTrace): Promise<void> {
    const { _id, ...rest } = toDoc(trace);
    await this.leafTraces.replaceOne({ _id }, rest, { upsert: true });
  }

  async appendLeafStep(trace: Omit<LeafTrace, 'steps'> & { step: AgentStep }): Promise<void> {
    const { id, step, ...rest } = trace;
    await this.leafTraces.updateOne(
      { _id: id as any },
      {
        $push: { steps: step as any },
        $set: { ...rest, totalSteps: trace.totalSteps, tokensUsed: trace.tokensUsed },
        $setOnInsert: { _id: id as any },
      },
      { upsert: true },
    );
  }

  async saveLeafEvidence(leafId: string, evidence: LeafEvidence): Promise<void> {
    await this.leafTraces.updateOne(
      { _id: leafId as any },
      { $set: { evidence: evidence as any }, $setOnInsert: { _id: leafId as any } },
      { upsert: true },
    );
  }

  async deleteLeafTrace(leafId: string): Promise<void> {
    await this.leafTraces.deleteOne({ _id: leafId as any });
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

  async getAppSpecs(): Promise<StoredAppSpec[]> {
    return (await this.appSpecs.find({}).toArray()).map((doc) => fromDoc<StoredAppSpec>(doc));
  }

  async saveAppSpec(spec: StoredAppSpec): Promise<void> {
    const doc = toDoc(spec);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.appSpecs.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async getClusterProviders(): Promise<ClusterProviderSpec[]> {
    const docs = (await this.clusterProviders.find({}).toArray()) as Array<Record<string, any>>;
    return docs.map(({ _id, ...rest }) => rest as ClusterProviderSpec);
  }

  async saveClusterProvider(provider: ClusterProviderSpec): Promise<void> {
    const { value, ...rest } = provider;
    await this.clusterProviders.replaceOne({ _id: value as any }, { _id: value, ...provider }, { upsert: true });
  }

  async deleteAppSpec(id: string): Promise<void> {
    await this.appSpecs.deleteOne({ _id: id as any });
  }

  async getConversations(): Promise<Conversation[]> {
    return (await this.conversations.find({}).toArray()).map((doc) => fromDoc<Conversation>(doc));
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    const doc = toDoc(conversation);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.conversations.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.conversations.deleteOne({ _id: id as any });
  }

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

  async getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]> {
    const filter = ownerId ? { ownerId } : {};
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

  async getPersonaPacks(): Promise<PersonaPack[]> {
    return (await this.personaPacks.find({}).toArray()).map(doc => fromDoc<PersonaPack>(doc));
  }

  async savePersonaPack(pack: PersonaPack): Promise<void> {
    const doc = toDoc(pack);
    const id = doc._id;
    delete (doc as any)._id;
    await this.personaPacks.replaceOne({ _id: id }, doc, { upsert: true });
  }

  async deletePersonaPack(id: string): Promise<void> {
    await this.personaPacks.deleteOne({ _id: id as any });
  }

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

  async getBindingTypes(): Promise<BindingTypeRecord[]> {
    return (await this.bindingTypes.find({}).toArray()).map((doc) => fromDoc<BindingTypeRecord>(doc));
  }

  async saveBindingType(record: BindingTypeRecord): Promise<void> {
    const doc = toDoc(record);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.bindingTypes.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async deleteBindingType(id: string): Promise<void> {
    await this.bindingTypes.deleteOne({ _id: id as any });
  }

  async getTools(): Promise<ToolRepositoryItem[]> {
    return (await this.tools.find({}).toArray()).map((d) => fromDoc<ToolRepositoryItem>(d));
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
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest as unknown as ModelThinkingProfile;
  }

  async saveModelThinkingProfile(profile: ModelThinkingProfile): Promise<void> {
    const { _id: _ignored, ...doc } = profile as ModelThinkingProfile & { _id?: unknown };
    await this.thinkingProfiles.replaceOne({ modelId: profile.modelId }, doc, { upsert: true });
  }
}