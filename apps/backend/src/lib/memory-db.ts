import type { Conversation } from './conversations.js';
import { hintKey, type McpToolHint } from './mcp-tool-hints.js';
import type { BenchSettings, BenchState } from './bench.js';
import type { ExtensionSettings } from './extension-settings.js';
import type { AuthoredExtension } from './authored-extensions.js';
import type { InstanceRecord, JoinToken } from './instances.js';
import type { StoredAppSpec } from './app-spec.js';
import type { ClusterProviderSpec } from './cluster-providers.js';
import { v4 as uuidv4 } from 'uuid';
import { mergeRecord } from './merge-record.js';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, UserMetadata, ProjectMetadata, PipelineRunMetadata, InviteMetadata, ModelEndpointMetadata, LocalAgentDeviceMetadata, PendingApprovalMetadata } from './types.js';
import type { Database, PartialInfo, BindingTypeRecord, SecretRequestFilter } from './db-interface.js';
import type { Branch, Leaf } from './leaves.js';
import type { Tree } from './trees.js';
import type { CorpusPage } from './corpus.js';
import { frontierOrder, type FrontierUrl, type FrontierClaim } from './frontier.js';
import type { AgentStep } from '@koala/harness-types';
import type { GiteaAccount } from './projects.js';
import type { ModelThinkingProfile } from './thinking-classifier.js';
import type { MemoryItem } from './memory-store.js';
import type { Task } from '../engine-host/tools/tasks.js';
import type { PlanProposal } from './plan-proposals.js';
import type { SecretRequest } from './secret-requests.js';
import type { AccessRequest, ActionProposal, EgressGrantRecord, EgressRequest, McpRequest } from '@koala/harness-types';
import { procedureKey, type ProcedureSource } from './procedure-source.js';
import { runTraceKey, type StoredNodeTrace } from './run-traces.js';
import type { RunEffort } from '@koala/agent-engine/procedure';
import type { Persona as EnginePersona, ToolDefinition as EngineTool } from '@koala/agent-engine';
import { evalRecordKey, type EvalCollection, type EvalRecord } from './eval-run.js';
import type { TreeTypeSpec } from './tree-types.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';

export class MemoryDB implements Database {
  private clusters: ClusterMetadata[] = [];
  private deployments: DeploymentMetadata[] = [];
  private users: UserMetadata[] = [];
  private projects: ProjectMetadata[] = [];
  private pipelineRuns: PipelineRunMetadata[] = [];
  private invites: InviteMetadata[] = [];
  private modelEndpoints: ModelEndpointMetadata[] = [];
  private localAgentDevices: LocalAgentDeviceMetadata[] = [];
  private pendingApprovals: PendingApprovalMetadata[] = [];
  private leaves: Leaf[] = [];
  private corpus: CorpusPage[] = [];
  private frontier: FrontierUrl[] = [];
  private trees: Tree[] = [];
  private branches: Branch[] = [];
  private conversations: Conversation[] = [];
  private appSpecs: StoredAppSpec[] = [];
  private clusterProviders: ClusterProviderSpec[] = [];
  private giteaAccounts: GiteaAccount[] = [];
  private modelThinkingProfiles: ModelThinkingProfile[] = [];
  private treeTypes: TreeTypeSpec[] = [];
  private workspaceImages: WorkspaceImageSpec[] = [];
  private memories: MemoryItem[] = [];
  private tasks: Task[] = [];
  private planProposals: PlanProposal[] = [];
  private secretRequests: SecretRequest[] = [];
  private mcpRequests: McpRequest[] = [];
  private mcpToolHints = new Map<string, McpToolHint>();
  private actionProposals: ActionProposal[] = [];
  private egressGrants: EgressGrantRecord[] = [];
  private extensionSettings = new Map<string, ExtensionSettings>();
  private authoredExtensions = new Map<string, AuthoredExtension>();
  private handoffs = new Map<string, string>();
  private instances = new Map<string, InstanceRecord>();
  private joinTokens = new Map<string, JoinToken>();
  private egressRequests: EgressRequest[] = [];
  private accessRequests: AccessRequest[] = [];
  private procedures: ProcedureSource[] = [];
  private runTraces = new Map<string, StoredNodeTrace>();
  private runEffort = new Map<string, RunEffort>();
  private memoryWatermarks = new Map<string, string>();
  private benchSettings = new Map<string, BenchSettings>();
  private benchStates = new Map<string, BenchState>();
  private enginePersonas: EnginePersona[] = [];
  private engineTools: EngineTool[] = [];
  private evalRecords = new Map<EvalCollection, Map<string, EvalRecord & { state?: unknown; startedAt?: unknown }>>();
  private bindingTypes: BindingTypeRecord[] = [];

  async init(): Promise<void> {
    this.clusters = [];
    this.deployments = [];
    this.users = [];
    this.pipelineRuns = [];
    this.invites = [];
    this.modelEndpoints = [];
    this.localAgentDevices = [];
    this.pendingApprovals = [];
    this.leaves = [];
    this.branches = [];
    this.conversations = [];
    this.appSpecs = [];
    this.giteaAccounts = [];
  }

  async close(): Promise<void> {
    this.clusters = [];
    this.deployments = [];
    this.users = [];
    this.pipelineRuns = [];
    this.invites = [];
    this.modelEndpoints = [];
    this.localAgentDevices = [];
    this.pendingApprovals = [];
    this.leaves = [];
    this.branches = [];
    this.conversations = [];
    this.appSpecs = [];
    this.giteaAccounts = [];
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

  async getLocalAgentDevices(): Promise<LocalAgentDeviceMetadata[]> {
    return this.localAgentDevices;
  }

  async saveLocalAgentDevice(device: LocalAgentDeviceMetadata): Promise<void> {
    const i = this.localAgentDevices.findIndex((d) => d.id === device.id);
    if (i >= 0) this.localAgentDevices[i] = device;
    else this.localAgentDevices.push(device);
  }

  async deleteLocalAgentDevice(id: string): Promise<void> {
    this.localAgentDevices = this.localAgentDevices.filter((d) => d.id !== id);
  }

  async getPendingApprovals(): Promise<PendingApprovalMetadata[]> {
    return this.pendingApprovals;
  }

  async savePendingApproval(approval: PendingApprovalMetadata): Promise<void> {
    const i = this.pendingApprovals.findIndex((a) => a.id === approval.id);
    if (i >= 0) this.pendingApprovals[i] = approval;
    else this.pendingApprovals.push(approval);
  }

  async deletePendingApproval(id: string): Promise<void> {
    this.pendingApprovals = this.pendingApprovals.filter((a) => a.id !== id);
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

  async getWorkspaceImages(ownerId?: string): Promise<WorkspaceImageSpec[]> {
    return ownerId
      ? this.workspaceImages.filter((i) => i.ownerId === ownerId || i.ownerId === undefined)
      : this.workspaceImages;
  }

  async saveWorkspaceImage(image: WorkspaceImageSpec): Promise<void> {
    const i = this.workspaceImages.findIndex((x) => x.id === image.id && x.ownerId === image.ownerId);
    if (i >= 0) this.workspaceImages[i] = image;
    else this.workspaceImages.push(image);
  }

  async getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]> {
    return ownerId
      ? this.treeTypes.filter((t) => t.ownerId === ownerId || t.ownerId === undefined)
      : this.treeTypes;
  }

  async saveTreeType(treeType: TreeTypeSpec): Promise<void> {
    const i = this.treeTypes.findIndex((t) => t.id === treeType.id && t.ownerId === treeType.ownerId);
    if (i >= 0) this.treeTypes[i] = treeType;
    else this.treeTypes.push(treeType);
  }

  async deleteTreeType(id: string, ownerId: string): Promise<void> {
    this.treeTypes = this.treeTypes.filter((t) => !(t.id === id && t.ownerId === ownerId));
  }

  async getModelThinkingProfile(modelId: string): Promise<ModelThinkingProfile | null> {
    return this.modelThinkingProfiles.find((p) => p.modelId === modelId) ?? null;
  }

  async saveModelThinkingProfile(profile: ModelThinkingProfile): Promise<void> {
    const i = this.modelThinkingProfiles.findIndex((p) => p.modelId === profile.modelId);
    if (i >= 0) this.modelThinkingProfiles[i] = profile;
    else this.modelThinkingProfiles.push(profile);
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

  async getConversation(ownerId: string, id: string): Promise<Conversation | undefined> {
    return this.conversations.find((c) => c.id === id && c.ownerId === ownerId);
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

  async getTasks(ownerId?: string): Promise<Task[]> {
    if (!ownerId) return [...this.tasks];
    return this.tasks.filter((t) => t.ownerId === ownerId);
  }

  async saveTask(task: Task): Promise<void> {
    const idx = this.tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) this.tasks[idx] = task;
    else this.tasks.push(task);
  }

  async getPlanProposals(ownerId: string, conversationId?: string): Promise<PlanProposal[]> {
    return this.planProposals
      .filter((p) => p.ownerId === ownerId && (conversationId === undefined || p.conversationId === conversationId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getPlanProposal(ownerId: string, id: string): Promise<PlanProposal | undefined> {
    return this.planProposals.find((p) => p.id === id && p.ownerId === ownerId);
  }

  async savePlanProposal(proposal: PlanProposal): Promise<void> {
    const idx = this.planProposals.findIndex((p) => p.id === proposal.id);
    if (idx >= 0) this.planProposals[idx] = proposal;
    else this.planProposals.push(proposal);
  }

  async deletePlanProposal(ownerId: string, id: string): Promise<void> {
    this.planProposals = this.planProposals.filter((p) => !(p.id === id && p.ownerId === ownerId));
  }

  async getSecretRequests(ownerId: string, filter: SecretRequestFilter = {}): Promise<SecretRequest[]> {
    return this.secretRequests
      .filter((r) => r.ownerId === ownerId
        && (filter.conversationId === undefined || r.conversationId === filter.conversationId)
        && (filter.projectId === undefined || r.projectId === filter.projectId)
        && (filter.treeId === undefined || r.treeId === filter.treeId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getSecretRequest(ownerId: string, id: string): Promise<SecretRequest | undefined> {
    return this.secretRequests.find((r) => r.id === id && r.ownerId === ownerId);
  }

  async saveSecretRequest(request: SecretRequest): Promise<void> {
    const idx = this.secretRequests.findIndex((r) => r.id === request.id);
    if (idx >= 0) this.secretRequests[idx] = request;
    else this.secretRequests.push(request);
  }

  async deleteSecretRequest(ownerId: string, id: string): Promise<void> {
    this.secretRequests = this.secretRequests.filter((r) => !(r.id === id && r.ownerId === ownerId));
  }

  async getMcpToolHints(ownerId: string): Promise<McpToolHint[]> {
    return [...this.mcpToolHints.values()].filter((hint) => hint.ownerId === ownerId);
  }

  async saveMcpToolHint(hint: McpToolHint): Promise<void> {
    this.mcpToolHints.set(hintKey(hint.ownerId, hint.server, hint.tool), { ...hint });
  }

  async deleteMcpToolHint(ownerId: string, server: string, tool: string): Promise<void> {
    this.mcpToolHints.delete(hintKey(ownerId, server, tool));
  }

  async getMcpRequests(ownerId: string, conversationId?: string): Promise<McpRequest[]> {
    return this.mcpRequests
      .filter((r) => r.ownerId === ownerId && (conversationId === undefined || r.conversationId === conversationId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getMcpRequest(ownerId: string, id: string): Promise<McpRequest | undefined> {
    return this.mcpRequests.find((r) => r.id === id && r.ownerId === ownerId);
  }

  async getActionProposals(ownerId: string, filter: { conversationId?: string | undefined; treeId?: string | undefined } = {}): Promise<ActionProposal[]> {
    return this.actionProposals
      .filter((p) => p.ownerId === ownerId
        && (filter.conversationId === undefined || p.conversationId === filter.conversationId)
        && (filter.treeId === undefined || p.treeId === filter.treeId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getActionProposal(ownerId: string, id: string): Promise<ActionProposal | undefined> {
    return this.actionProposals.find((p) => p.id === id && p.ownerId === ownerId);
  }

  async saveActionProposal(proposal: ActionProposal): Promise<void> {
    const idx = this.actionProposals.findIndex((p) => p.id === proposal.id);
    if (idx >= 0) this.actionProposals[idx] = proposal;
    else this.actionProposals.push(proposal);
  }

  async getExtensionSettings(ownerId: string): Promise<ExtensionSettings | undefined> {
    const found = this.extensionSettings.get(ownerId);
    return found ? { ...found, disabled: [...found.disabled] } : undefined;
  }

  async claimHandoff(jti: string, expiresAt: string): Promise<boolean> {
    const now = new Date().toISOString();
    for (const [id, until] of this.handoffs) if (until <= now) this.handoffs.delete(id);
    if (this.handoffs.has(jti)) return false;
    this.handoffs.set(jti, expiresAt);
    return true;
  }

  async saveJoinToken(token: JoinToken): Promise<void> {
    this.joinTokens.set(token.hash, { ...token });
  }

  async takeJoinToken(hash: string): Promise<JoinToken | undefined> {
    const token = this.joinTokens.get(hash);
    this.joinTokens.delete(hash);
    return token;
  }

  async getInstances(ownerId?: string): Promise<InstanceRecord[]> {
    return [...this.instances.values()].filter((instance) => !ownerId || instance.ownerId === ownerId).map((instance) => ({ ...instance }));
  }

  async saveInstance(instance: InstanceRecord): Promise<void> {
    this.instances.set(instance.id, { ...instance });
  }

  async deleteInstance(id: string): Promise<void> {
    this.instances.delete(id);
  }

  async getAuthoredExtensions(ownerId: string): Promise<AuthoredExtension[]> {
    return [...this.authoredExtensions.values()].filter((extension) => extension.ownerId === ownerId).map((extension) => structuredClone(extension));
  }

  async saveAuthoredExtension(extension: AuthoredExtension): Promise<void> {
    this.authoredExtensions.set(`${extension.ownerId}:${extension.id}`, structuredClone(extension));
  }

  async deleteAuthoredExtension(ownerId: string, id: string): Promise<void> {
    this.authoredExtensions.delete(`${ownerId}:${id}`);
  }

  async saveExtensionSettings(settings: ExtensionSettings): Promise<void> {
    this.extensionSettings.set(settings.ownerId, { ...settings, disabled: [...settings.disabled] });
  }

  async getEgressGrants(ownerId?: string): Promise<EgressGrantRecord[]> {
    return this.egressGrants.filter((g) => ownerId === undefined || g.ownerId === ownerId);
  }

  async saveEgressGrant(grant: EgressGrantRecord): Promise<void> {
    const idx = this.egressGrants.findIndex((g) => g.id === grant.id);
    if (idx >= 0) this.egressGrants[idx] = grant;
    else this.egressGrants.push(grant);
  }

  async getEgressRequests(ownerId: string, filter: { conversationId?: string | undefined; treeId?: string | undefined } = {}): Promise<EgressRequest[]> {
    return this.egressRequests
      .filter((r) => r.ownerId === ownerId
        && (filter.conversationId === undefined || r.conversationId === filter.conversationId)
        && (filter.treeId === undefined || r.treeId === filter.treeId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getEgressRequest(ownerId: string, id: string): Promise<EgressRequest | undefined> {
    return this.egressRequests.find((r) => r.id === id && r.ownerId === ownerId);
  }

  async saveEgressRequest(request: EgressRequest): Promise<void> {
    const idx = this.egressRequests.findIndex((r) => r.id === request.id);
    if (idx >= 0) this.egressRequests[idx] = request;
    else this.egressRequests.push(request);
  }

  async getAccessRequests(ownerId: string, conversationId?: string): Promise<AccessRequest[]> {
    return this.accessRequests
      .filter((r) => r.ownerId === ownerId && (conversationId === undefined || r.conversationId === conversationId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getAccessRequest(ownerId: string, id: string): Promise<AccessRequest | undefined> {
    return this.accessRequests.find((r) => r.id === id && r.ownerId === ownerId);
  }

  async saveAccessRequest(request: AccessRequest): Promise<void> {
    const idx = this.accessRequests.findIndex((r) => r.id === request.id);
    if (idx >= 0) this.accessRequests[idx] = request;
    else this.accessRequests.push(request);
  }

  async saveMcpRequest(request: McpRequest): Promise<void> {
    const idx = this.mcpRequests.findIndex((r) => r.id === request.id);
    if (idx >= 0) this.mcpRequests[idx] = request;
    else this.mcpRequests.push(request);
  }

  async getProcedure(ownerId: string, id: string): Promise<ProcedureSource | undefined> {
    return this.procedures.find((s) => procedureKey(s.ownerId, s.id) === procedureKey(ownerId, id));
  }

  async getProcedures(ownerId?: string): Promise<ProcedureSource[]> {
    if (ownerId === undefined) return [...this.procedures];
    return this.procedures.filter((s) => s.ownerId === ownerId || s.ownerId === undefined);
  }

  async saveProcedure(source: ProcedureSource): Promise<void> {
    const key = procedureKey(source.ownerId, source.id);
    const idx = this.procedures.findIndex((s) => procedureKey(s.ownerId, s.id) === key);
    if (idx >= 0) this.procedures[idx] = source;
    else this.procedures.push(source);
  }

  async saveRunTraces(traces: StoredNodeTrace[]): Promise<void> {
    for (const trace of traces) this.runTraces.set(runTraceKey(trace.runId, trace.sequence), trace);
  }

  async saveRunEffort(effort: RunEffort): Promise<void> {
    this.runEffort.set(effort.runId, effort);
  }

  async getBenchSettings(ownerId: string): Promise<BenchSettings | undefined> {
    const found = this.benchSettings.get(ownerId);
    return found ? { ...found } : undefined;
  }

  async saveBenchSettings(ownerId: string, settings: BenchSettings): Promise<void> {
    this.benchSettings.set(ownerId, { ...settings });
  }

  async getBenchState(ownerId: string): Promise<BenchState | undefined> {
    const found = this.benchStates.get(ownerId);
    return found ? { ...found, benched: { ...found.benched } } : undefined;
  }

  async saveBenchState(state: BenchState): Promise<void> {
    this.benchStates.set(state.ownerId, { ...state, benched: { ...state.benched } });
  }

  async getMemoryWatermark(key: string): Promise<string | undefined> {
    return this.memoryWatermarks.get(key);
  }

  async saveMemoryWatermark(key: string, value: string): Promise<void> {
    this.memoryWatermarks.set(key, value);
  }

  async getRunEffort(ownerId: string, procedureId: string, modelKey?: string): Promise<RunEffort[]> {
    return [...this.runEffort.values()]
      .filter((effort) => effort.ownerId === ownerId && effort.procedureId === procedureId && (!modelKey || effort.modelKey === modelKey))
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  }

  async getRunTraces(ownerId: string, runId: string): Promise<StoredNodeTrace[]> {
    return [...this.runTraces.values()]
      .filter((trace) => trace.ownerId === ownerId && trace.runId === runId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async deleteProcedure(ownerId: string | undefined, id: string): Promise<void> {
    this.procedures = this.procedures.filter((s) => procedureKey(s.ownerId, s.id) !== procedureKey(ownerId, id));
  }

  async getEnginePersonas(ownerId?: string): Promise<EnginePersona[]> {
    if (ownerId === undefined) return [...this.enginePersonas];
    return this.enginePersonas.filter((p) => p.ownerId === ownerId || p.ownerId === undefined);
  }

  async getEngineTools(ownerId?: string): Promise<EngineTool[]> {
    if (ownerId === undefined) return [...this.engineTools];
    return this.engineTools.filter((t) => t.ownerId === ownerId || t.ownerId === undefined);
  }

  private evalCollection(collection: EvalCollection) {
    const found = this.evalRecords.get(collection) ?? new Map();
    this.evalRecords.set(collection, found);
    return found;
  }

  async getEvalRecords<T extends EvalRecord>(collection: EvalCollection, ownerId: string, limit = 200): Promise<T[]> {
    return [...this.evalCollection(collection).values()]
      .filter((record) => record.ownerId === ownerId)
      .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
      .slice(0, limit)
      .map((record) => structuredClone(record) as unknown as T);
  }

  async getEvalRecordsInState<T extends EvalRecord>(collection: EvalCollection, state: string): Promise<T[]> {
    return [...this.evalCollection(collection).values()].filter((record) => record.state === state).map((record) => structuredClone(record) as unknown as T);
  }

  async getEvalRecord<T extends EvalRecord>(collection: EvalCollection, ownerId: string, id: string): Promise<T | null> {
    const found = this.evalCollection(collection).get(evalRecordKey(ownerId, id));
    return found ? (structuredClone(found) as unknown as T) : null;
  }

  async saveEvalRecord<T extends EvalRecord>(collection: EvalCollection, record: T): Promise<void> {
    this.evalCollection(collection).set(evalRecordKey(record.ownerId, record.id), structuredClone(record));
  }

  async deleteEvalRecord(collection: EvalCollection, ownerId: string, id: string): Promise<void> {
    this.evalCollection(collection).delete(evalRecordKey(ownerId, id));
  }

  async saveEngineTool(tool: EngineTool): Promise<void> {
    const idx = this.engineTools.findIndex((t) => t.name === tool.name && t.ownerId === tool.ownerId);
    if (idx >= 0) this.engineTools[idx] = tool;
    else this.engineTools.push(tool);
  }

  async saveEnginePersona(persona: EnginePersona): Promise<void> {
    const idx = this.enginePersonas.findIndex((p) => p.slug === persona.slug && p.ownerId === persona.ownerId);
    if (idx >= 0) this.enginePersonas[idx] = persona;
    else this.enginePersonas.push(persona);
  }

  async deleteEngineTool(ownerId: string | undefined, name: string): Promise<void> {
    this.engineTools = this.engineTools.filter((t) => !(t.name === name && t.ownerId === ownerId));
  }

  async deleteEnginePersona(ownerId: string | undefined, slug: string): Promise<void> {
    this.enginePersonas = this.enginePersonas.filter((p) => !(p.slug === slug && p.ownerId === ownerId));
  }

  async deleteTask(id: string): Promise<void> {
    this.tasks = this.tasks.filter((t) => t.id !== id);
  }

  async getBindingTypes(): Promise<BindingTypeRecord[]> {
    return [...this.bindingTypes];
  }

  async saveBindingType(record: BindingTypeRecord): Promise<void> {
    const idx = this.bindingTypes.findIndex((b) => b.id === record.id);
    if (idx >= 0) this.bindingTypes[idx] = record;
    else this.bindingTypes.push(record);
  }

  async deleteBindingType(id: string): Promise<void> {
    this.bindingTypes = this.bindingTypes.filter((b) => b.id !== id);
  }

}
