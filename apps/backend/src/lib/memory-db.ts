import type { Persona } from '@koala/harness-types';
import type { Conversation } from './conversations.js';
import type { StoredAppSpec } from './app-spec.js';
import type { ClusterProviderSpec } from './cluster-providers.js';
import { v4 as uuidv4 } from 'uuid';
import { mergeRecord } from './merge-record.js';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, UserMetadata, ProjectMetadata, PipelineRunMetadata, InviteMetadata, ModelEndpointMetadata } from './types.js';
import type { Database, PartialInfo } from './db-interface.js';
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
import { TOOL_REPOSITORY, type ToolRepositoryItem } from './tool-repository.js';

export class MemoryDB implements Database {
  private clusters: ClusterMetadata[] = [];
  private deployments: DeploymentMetadata[] = [];
  private users: UserMetadata[] = [];
  private projects: ProjectMetadata[] = [];
  private pipelineRuns: PipelineRunMetadata[] = [];
  private invites: InviteMetadata[] = [];
  private modelEndpoints: ModelEndpointMetadata[] = [];
  private leaves: Leaf[] = [];
  private corpus: CorpusPage[] = [];
  private frontier: FrontierUrl[] = [];
  private leafTraces: LeafTrace[] = [];
  private trees: Tree[] = [];
  private branches: Branch[] = [];
  private conversations: Conversation[] = [];
  private appSpecs: StoredAppSpec[] = [];
  private clusterProviders: ClusterProviderSpec[] = [];
  private giteaAccounts: GiteaAccount[] = [];
  private experiments: Experiment[] = [];
  private harnessProfiles: HarnessProfile[] = [];
private treeTypes: TreeTypeSpec[] = [];
  private personas: Persona[] = [];
  private memories: MemoryItem[] = [];
  private customTools: ToolRepositoryItem[] = [];

  async init(): Promise<void> {
    this.clusters = [];
    this.deployments = [];
    this.users = [];
    this.pipelineRuns = [];
    this.invites = [];
    this.modelEndpoints = [];
    this.leaves = [];
    this.branches = [];
    this.conversations = [];
    this.appSpecs = [];
    this.giteaAccounts = [];
    this.experiments = [];
  }

  async close(): Promise<void> {
    this.clusters = [];
    this.deployments = [];
    this.users = [];
    this.pipelineRuns = [];
    this.invites = [];
    this.modelEndpoints = [];
    this.leaves = [];
    this.branches = [];
    this.conversations = [];
    this.appSpecs = [];
    this.giteaAccounts = [];
    this.experiments = [];
  }

  async getClusters(): Promise<ClusterMetadata[]> {
    return [...this.clusters];
  }

  async saveCluster(cluster: ClusterMetadata): Promise<void> {
    const idx = this.clusters.findIndex(c => c.id === cluster.id);
    if (idx >= 0) this.clusters[idx] = cluster;
    else this.clusters.push(cluster);
  }

  async saveClusterList(clusters: ClusterMetadata[]): Promise<void> {
    this.clusters = [...clusters];
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
    const idx = this.clusters.findIndex(c => c.id === clusterId);
    const existing = this.clusters[idx];
    // Bind before spreading — under noUncheckedIndexedAccess an indexed read is `T | undefined`
    // even after an `idx >= 0` check, since TS can't tie the two together.
    if (existing) {
      this.clusters[idx] = { ...existing, progress };
    }
  }

  async getDeployments(): Promise<DeploymentMetadata[]> {
    return [...this.deployments];
  }

  async saveDeployment(deployment: DeploymentMetadata): Promise<void> {
    const idx = this.deployments.findIndex(d => d.id === deployment.id);
    if (idx >= 0) this.deployments[idx] = deployment;
    else this.deployments.push(deployment);
  }

  async deleteDeployment(id: string): Promise<void> {
    this.deployments = this.deployments.filter((d) => d.id !== id);
  }

  async saveDeploymentList(deployments: DeploymentMetadata[]): Promise<void> {
    this.deployments = [...deployments];
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
    return [...this.projects];
  }

  async saveProject(project: ProjectMetadata): Promise<void> {
    const idx = this.projects.findIndex(p => p.id === project.id);
    if (idx >= 0) this.projects[idx] = project;
    else this.projects.push(project);
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
    return [...this.pipelineRuns];
  }

  async savePipelineRun(run: PipelineRunMetadata): Promise<void> {
    const idx = this.pipelineRuns.findIndex(r => r.id === run.id);
    if (idx >= 0) this.pipelineRuns[idx] = run;
    else this.pipelineRuns.push(run);
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
    return [...this.invites];
  }

  async saveInvite(invite: InviteMetadata): Promise<void> {
    const idx = this.invites.findIndex(i => i.id === invite.id);
    if (idx >= 0) this.invites[idx] = invite;
    else this.invites.push(invite);
  }

  async getUsers(): Promise<UserMetadata[]> {
    return [...this.users];
  }

  async saveUser(user: UserMetadata): Promise<void> {
    const idx = this.users.findIndex(u => u.id === user.id);
    if (idx >= 0) this.users[idx] = user;
    else this.users.push(user);
  }

  async saveUserList(users: UserMetadata[]): Promise<void> {
    this.users = [...users];
  }

  /**
   * Matches Mongo's semantics exactly, which means normalising the QUERY and not the stored value.
   *
   * This used to normalise both sides, and that leniency hid a real defect: `mongo-db.ts` does
   * `findOne({ email: email.trim().toLowerCase() })` against whatever was written, so a user stored
   * as `MixedCase@Example.COM` is unreachable forever — every login says "Invalid email or
   * password" with the correct password. Under the old MemoryDB that was a green test.
   *
   * Registration normalises before writing (see `routes/auth.ts`), so this is strictly the
   * safety net for the next write path that forgets to.
   */
  async getUserByEmail(email: string): Promise<UserMetadata | undefined> {
    const cleanEmail = email.trim().toLowerCase();
    return this.users.find(u => u.email === cleanEmail);
  }

  async getUserById(id: string): Promise<UserMetadata | undefined> {
    return this.users.find(u => u.id === id);
  }

  async getModelEndpoints(): Promise<ModelEndpointMetadata[]> {
    return this.modelEndpoints;
  }

  async saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void> {
    const i = this.modelEndpoints.findIndex((e) => e.id === endpoint.id);
    if (i >= 0) this.modelEndpoints[i] = endpoint;
    else this.modelEndpoints.push(endpoint);
  }

  async deleteModelEndpoint(id: string): Promise<void> {
    this.modelEndpoints = this.modelEndpoints.filter((e) => e.id !== id);
  }

  async getLeaves(): Promise<Leaf[]> {
    return this.leaves;
  }

  async saveLeaf(leaf: Leaf): Promise<void> {
    const i = this.leaves.findIndex((c) => c.id === leaf.id);
    if (i >= 0) this.leaves[i] = leaf;
    else this.leaves.push(leaf);
  }

  async deleteLeaf(id: string): Promise<void> {
    this.leaves = this.leaves.filter((c) => c.id !== id);
  }

  async getBranches(): Promise<Branch[]> {
    return this.branches;
  }

  async getExperiments(): Promise<Experiment[]> {
    return this.experiments;
  }

  async saveExperiment(experiment: Experiment): Promise<void> {
    const i = this.experiments.findIndex((e) => e.id === experiment.id);
    if (i >= 0) this.experiments[i] = experiment;
    else this.experiments.push(experiment);
  }

  async deleteExperiment(id: string): Promise<void> {
    this.experiments = this.experiments.filter((e) => e.id !== id);
  }

  async getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]> {
    return ownerId ? this.treeTypes.filter((t) => t.ownerId === ownerId) : this.treeTypes;
  }

  async saveTreeType(treeType: TreeTypeSpec): Promise<void> {
    // Keyed on (owner, id): a type id is unique per owner, not globally — two people may both have
    // a "playbook" type and they are not the same record.
    const i = this.treeTypes.findIndex((t) => t.id === treeType.id && t.ownerId === treeType.ownerId);
    if (i >= 0) this.treeTypes[i] = treeType;
    else this.treeTypes.push(treeType);
  }

  async deleteTreeType(id: string, ownerId: string): Promise<void> {
    this.treeTypes = this.treeTypes.filter((t) => !(t.id === id && t.ownerId === ownerId));
  }

  async getPersonas(): Promise<Persona[]> {
    return this.personas;
  }

  async savePersona(persona: Persona): Promise<void> {
    const i = this.personas.findIndex((p) => p.id === persona.id);
    if (i >= 0) this.personas[i] = persona;
    else this.personas.push(persona);
  }

  async deletePersona(id: string): Promise<void> {
    this.personas = this.personas.filter((p) => p.id !== id);
  }

  async getHarnessProfile(ownerId: string): Promise<HarnessProfile | null> {
    return this.harnessProfiles.find((p) => p.ownerId === ownerId) ?? null;
  }

  async saveHarnessProfile(profile: HarnessProfile): Promise<void> {
    const i = this.harnessProfiles.findIndex((p) => p.ownerId === profile.ownerId);
    if (i >= 0) this.harnessProfiles[i] = profile;
    else this.harnessProfiles.push(profile);
  }

  async deleteHarnessProfile(ownerId: string): Promise<void> {
    this.harnessProfiles = this.harnessProfiles.filter((p) => p.ownerId !== ownerId);
  }

  async getGiteaAccount(ownerId: string): Promise<GiteaAccount | null> {
    return this.giteaAccounts.find((a) => a.ownerId === ownerId) ?? null;
  }

  async saveGiteaAccount(account: GiteaAccount): Promise<void> {
    const i = this.giteaAccounts.findIndex((a) => a.ownerId === account.ownerId);
    if (i >= 0) this.giteaAccounts[i] = account;
    else this.giteaAccounts.push(account);
  }

  async saveBranch(branch: Branch): Promise<void> {
    const i = this.branches.findIndex((b) => b.id === branch.id);
    if (i >= 0) this.branches[i] = branch;
    else this.branches.push(branch);
  }

  async deleteBranch(id: string): Promise<void> {
    this.branches = this.branches.filter((b) => b.id !== id);
  }

  async getAppSpecs(): Promise<StoredAppSpec[]> {
    return this.appSpecs;
  }

  async saveAppSpec(spec: StoredAppSpec): Promise<void> {
    const i = this.appSpecs.findIndex((s) => s.id === spec.id);
    if (i >= 0) this.appSpecs[i] = spec;
    else this.appSpecs.push(spec);
  }

  async getClusterProviders(): Promise<ClusterProviderSpec[]> {
    return this.clusterProviders;
  }

  async saveClusterProvider(provider: ClusterProviderSpec): Promise<void> {
    const i = this.clusterProviders.findIndex((p) => p.value === provider.value);
    if (i >= 0) this.clusterProviders[i] = provider;
    else this.clusterProviders.push(provider);
  }

  async deleteAppSpec(id: string): Promise<void> {
    this.appSpecs = this.appSpecs.filter((s) => s.id !== id);
  }

  async getConversations(): Promise<Conversation[]> {
    return this.conversations;
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    const i = this.conversations.findIndex((c) => c.id === conversation.id);
    if (i >= 0) this.conversations[i] = conversation;
    else this.conversations.push(conversation);
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations = this.conversations.filter((c) => c.id !== id);
  }

  async getCorpusPages(filter: { ownerId: string; ingestId?: string; projectId?: string }): Promise<CorpusPage[]> {
    return this.corpus.filter((p) => p.ownerId === filter.ownerId
      && (!filter.ingestId || p.ingestId === filter.ingestId)
      && (!filter.projectId || p.projectId === filter.projectId));
  }

  async saveCorpusPages(pages: CorpusPage[]): Promise<void> {
    for (const page of pages) {
      const i = this.corpus.findIndex((p) => p.id === page.id);
      if (i >= 0) this.corpus[i] = page; else this.corpus.push(page);
    }
  }

  async deleteCorpus(ingestId: string): Promise<void> {
    this.corpus = this.corpus.filter((p) => p.ingestId !== ingestId);
  }

  async enqueueFrontier(urls: FrontierUrl[]): Promise<number> {
    let added = 0;
    for (const u of urls) {
      // The id is what Mongo's unique index enforces; here the same check is explicit.
      if (this.frontier.some((f) => f.id === u.id)) continue;
      this.frontier.push(u);
      added += 1;
    }
    return added;
  }

  async claimFrontier(ingestId: string, limit: number): Promise<FrontierClaim[]> {
    if (limit <= 0) return [];
    return this.frontier
      .filter((f) => f.ingestId === ingestId && f.state === 'pending')
      .sort(frontierOrder)
      .slice(0, limit)
      .map((f) => ({ url: f.url, depth: f.depth }));
  }

  async completeFrontier(ingestId: string, urls: string[]): Promise<void> {
    const done = new Set(urls);
    for (const f of this.frontier) {
      if (f.ingestId === ingestId && done.has(f.url)) f.state = 'done';
    }
  }

  async countFrontier(ingestId: string): Promise<number> {
    return this.frontier.filter((f) => f.ingestId === ingestId && f.state === 'pending').length;
  }

  async deleteFrontier(ingestId: string): Promise<void> {
    this.frontier = this.frontier.filter((f) => f.ingestId !== ingestId);
  }

  async getLeafTrace(leafId: string): Promise<LeafTrace | null> {
    return this.leafTraces.find((t) => t.id === leafId) ?? null;
  }

  async saveLeafTrace(trace: LeafTrace): Promise<void> {
    const i = this.leafTraces.findIndex((t) => t.id === trace.id);
    if (i >= 0) this.leafTraces[i] = trace; else this.leafTraces.push(trace);
  }

  async appendLeafStep(trace: Omit<LeafTrace, 'steps'> & { step: AgentStep }): Promise<void> {
    const { step, ...rest } = trace;
    const existing = this.leafTraces.find((t) => t.id === trace.id);
    if (existing) {
      existing.steps.push(step);
      Object.assign(existing, rest);
      return;
    }
    this.leafTraces.push({ ...rest, steps: [step] });
  }

  async saveLeafEvidence(leafId: string, evidence: LeafEvidence): Promise<void> {
    const existing = this.leafTraces.find((t) => t.id === leafId);
    if (existing) existing.evidence = evidence;
  }

  async deleteLeafTrace(leafId: string): Promise<void> {
    this.leafTraces = this.leafTraces.filter((t) => t.id !== leafId);
  }

  async getTrees(): Promise<Tree[]> {
    return [...this.trees];
  }

  async saveTree(tree: Tree): Promise<void> {
    const i = this.trees.findIndex((t) => t.id === tree.id);
    if (i >= 0) this.trees[i] = tree;
    else this.trees.push(tree);
  }

  async deleteTree(id: string): Promise<void> {
    this.trees = this.trees.filter((t) => t.id !== id);
  }

  async getMemories(ownerId?: string): Promise<MemoryItem[]> {
    if (!ownerId) return [...this.memories];
    return this.memories.filter((m) => m.ownerId === ownerId);
  }

  async saveMemory(memory: MemoryItem): Promise<void> {
    const idx = this.memories.findIndex((m) => m.id === memory.id);
    if (idx >= 0) this.memories[idx] = memory;
    else this.memories.push(memory);
  }

  async deleteMemory(id: string): Promise<void> {
    this.memories = this.memories.filter((m) => m.id !== id);
  }

  async getTools(): Promise<ToolRepositoryItem[]> {
    const builtIns = TOOL_REPOSITORY.map((t) => ({ ...t, isBuiltIn: true }));
    const customMap = new Map(this.customTools.map((t) => [t.id, t]));
    const result = builtIns.map((t) => customMap.get(t.id) ?? t);
    for (const c of this.customTools) {
      if (!result.some((r) => r.id === c.id)) {
        result.push(c);
      }
    }
    return result;
  }

  async saveTool(tool: ToolRepositoryItem): Promise<void> {
    const idx = this.customTools.findIndex((t) => t.id === tool.id);
    if (idx >= 0) this.customTools[idx] = tool;
    else this.customTools.push(tool);
  }

  async deleteTool(id: string): Promise<void> {
    this.customTools = this.customTools.filter((t) => t.id !== id);
  }
}
