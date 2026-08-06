import { v4 as uuidv4 } from 'uuid';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, UserMetadata, ProjectMetadata, PipelineRunMetadata, InviteMetadata, ModelEndpointMetadata } from './types.js';
import type { Database, PartialInfo } from './db-interface.js';
import type { Branch, Leaf } from './leaves.js';
import type { GiteaAccount } from './projects.js';
import type { Experiment } from './experiments.js';
import type { HarnessProfile } from './harness-profile.js';
import type { MemoryItem } from './memory-store.js';
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
  private branches: Branch[] = [];
  private giteaAccounts: GiteaAccount[] = [];
  private experiments: Experiment[] = [];
  private harnessProfiles: HarnessProfile[] = [];
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
    const c: ClusterMetadata = {
      id: cluster.id || uuidv4(),
      name: cluster.name || '',
      provider: cluster.provider || 'k3d',
      status: cluster.status || 'provisioning',
    };
    if (cluster.kubeconfigPath !== undefined) c.kubeconfigPath = cluster.kubeconfigPath;
    if (cluster.lastLogPath !== undefined) c.lastLogPath = cluster.lastLogPath;
    if (cluster.temporalWorkflowId !== undefined) c.temporalWorkflowId = cluster.temporalWorkflowId;
    if (cluster.progress !== undefined) c.progress = cluster.progress;
    if (cluster.ownerId !== undefined) c.ownerId = cluster.ownerId;
    if (cluster.remoteHost !== undefined) c.remoteHost = cluster.remoteHost;
    if (cluster.remoteUsername !== undefined) c.remoteUsername = cluster.remoteUsername;
    if (cluster.remoteSshPort !== undefined) c.remoteSshPort = cluster.remoteSshPort;
    if (cluster.remoteK3sApiPort !== undefined) c.remoteK3sApiPort = cluster.remoteK3sApiPort;
    if (cluster.remoteSshPrivateKeyEnc !== undefined) c.remoteSshPrivateKeyEnc = cluster.remoteSshPrivateKeyEnc;
    if (cluster.meshNodeId !== undefined) c.meshNodeId = cluster.meshNodeId;
    if (cluster.createdAt !== undefined) c.createdAt = cluster.createdAt;
    if (cluster.gpuEnabled !== undefined) c.gpuEnabled = cluster.gpuEnabled;
    if (cluster.hetznerServerId !== undefined) c.hetznerServerId = cluster.hetznerServerId;
    if (cluster.hetznerServerType !== undefined) c.hetznerServerType = cluster.hetznerServerType;
    if (cluster.hetznerLocation !== undefined) c.hetznerLocation = cluster.hetznerLocation;
    if (cluster.hetznerImage !== undefined) c.hetznerImage = cluster.hetznerImage;
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
    const d: DeploymentMetadata = {
      id: deployment.id || uuidv4(),
      name: deployment.name || '',
      clusterId: deployment.clusterId || '',
      strategy: deployment.strategy || 'helm',
      status: deployment.status || 'deploying',
    };
    if (deployment.deploymentId !== undefined) d.deploymentId = deployment.deploymentId;
    if (deployment.appType !== undefined) d.appType = deployment.appType;
    if (deployment.webRepo !== undefined) d.webRepo = deployment.webRepo;
    if (deployment.webTag !== undefined) d.webTag = deployment.webTag;
    if (deployment.dbRepo !== undefined) d.dbRepo = deployment.dbRepo;
    if (deployment.dbTag !== undefined) d.dbTag = deployment.dbTag;
    if (deployment.url !== undefined) d.url = deployment.url;
    if (deployment.isExposed !== undefined) d.isExposed = deployment.isExposed;
    if (deployment.exposureUrl !== undefined) d.exposureUrl = deployment.exposureUrl;
    if (deployment.lastLogPath !== undefined) d.lastLogPath = deployment.lastLogPath;
    if (deployment.modules !== undefined) d.modules = deployment.modules;
    if (deployment.storage !== undefined) d.storage = deployment.storage;
    if (deployment.appSettings !== undefined) d.appSettings = deployment.appSettings;
    if (deployment.vpnEnabled !== undefined) d.vpnEnabled = deployment.vpnEnabled;
    if (deployment.vpnProtocol !== undefined) d.vpnProtocol = deployment.vpnProtocol;
    if (deployment.vpnConfig !== undefined) d.vpnConfig = deployment.vpnConfig;
    if (deployment.vpnDedicatedIp !== undefined) d.vpnDedicatedIp = deployment.vpnDedicatedIp;
    if (deployment.temporalWorkflowId !== undefined) d.temporalWorkflowId = deployment.temporalWorkflowId;
    if (deployment.vllmModel !== undefined) d.vllmModel = deployment.vllmModel;
    if (deployment.vllmGpuCount !== undefined) d.vllmGpuCount = deployment.vllmGpuCount;
    if (deployment.vllmGpuVendor !== undefined) d.vllmGpuVendor = deployment.vllmGpuVendor;
    if (deployment.vllmCachePvc !== undefined) d.vllmCachePvc = deployment.vllmCachePvc;
    if (deployment.vllmHfToken !== undefined) d.vllmHfToken = deployment.vllmHfToken;
    if (deployment.vllmMaxModelLen !== undefined) d.vllmMaxModelLen = deployment.vllmMaxModelLen;
    if (deployment.vllmGpuMemUtil !== undefined) d.vllmGpuMemUtil = deployment.vllmGpuMemUtil;
    if (deployment.vllmExtraArgs !== undefined) d.vllmExtraArgs = deployment.vllmExtraArgs;
    if (deployment.vllmToolCallingEnabled !== undefined) d.vllmToolCallingEnabled = deployment.vllmToolCallingEnabled;
    if (deployment.vllmToolCallParser !== undefined) d.vllmToolCallParser = deployment.vllmToolCallParser;
    if (deployment.vllmServedModelName !== undefined) d.vllmServedModelName = deployment.vllmServedModelName;
    if (deployment.vllmMaxNumSeqs !== undefined) d.vllmMaxNumSeqs = deployment.vllmMaxNumSeqs;
    if (deployment.vllmDtype !== undefined) d.vllmDtype = deployment.vllmDtype;
    if (deployment.vllmEnablePrefixCaching !== undefined) d.vllmEnablePrefixCaching = deployment.vllmEnablePrefixCaching;
    if (deployment.tabbyModel !== undefined) d.tabbyModel = deployment.tabbyModel;
    if (deployment.tabbyRevision !== undefined) d.tabbyRevision = deployment.tabbyRevision;
    if (deployment.tabbyGpuCount !== undefined) d.tabbyGpuCount = deployment.tabbyGpuCount;
    if (deployment.tabbyHfToken !== undefined) d.tabbyHfToken = deployment.tabbyHfToken;
    if (deployment.tabbyCachePvc !== undefined) d.tabbyCachePvc = deployment.tabbyCachePvc;
    if (deployment.tabbyImageTag !== undefined) d.tabbyImageTag = deployment.tabbyImageTag;
    if (deployment.tabbyCacheMode !== undefined) d.tabbyCacheMode = deployment.tabbyCacheMode;
    if (deployment.tabbyMaxSeqLen !== undefined) d.tabbyMaxSeqLen = deployment.tabbyMaxSeqLen;
    if (deployment.tabbyMaxBatchSize !== undefined) d.tabbyMaxBatchSize = deployment.tabbyMaxBatchSize;
    if (deployment.tabbyReasoning !== undefined) d.tabbyReasoning = deployment.tabbyReasoning;
    if (deployment.tabbyToolFormat !== undefined) d.tabbyToolFormat = deployment.tabbyToolFormat;
    if (deployment.tabbyInlineModelLoading !== undefined) d.tabbyInlineModelLoading = deployment.tabbyInlineModelLoading;
    if (deployment.tabbyDisableAuth !== undefined) d.tabbyDisableAuth = deployment.tabbyDisableAuth;
    if (deployment.tabbyExtraEnv !== undefined) d.tabbyExtraEnv = deployment.tabbyExtraEnv;
    if (deployment.openWebuiTargetId !== undefined) d.openWebuiTargetId = deployment.openWebuiTargetId;
    if (deployment.hermesTargetId !== undefined) d.hermesTargetId = deployment.hermesTargetId;
    if (deployment.webuiEnableWebSearch !== undefined) d.webuiEnableWebSearch = deployment.webuiEnableWebSearch;
    if (deployment.webuiWebSearchEngine !== undefined) d.webuiWebSearchEngine = deployment.webuiWebSearchEngine;
    if (deployment.webuiWebSearchApiKey !== undefined) d.webuiWebSearchApiKey = deployment.webuiWebSearchApiKey;
    if (deployment.ownerId !== undefined) d.ownerId = deployment.ownerId;
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
    const p: ProjectMetadata = {
      id: project.id || uuidv4(),
      name: project.name || '',
      giteaOwner: project.giteaOwner || '',
      giteaRepo: project.giteaRepo || '',
      appType: project.appType || 'gitapp',
      createdAt: project.createdAt || new Date().toISOString(),
    };
    if (project.targetClusterId !== undefined) p.targetClusterId = project.targetClusterId;
    if (project.targetNamespace !== undefined) p.targetNamespace = project.targetNamespace;
    if (project.autoDeployOnBuild !== undefined) p.autoDeployOnBuild = project.autoDeployOnBuild;
    if (project.lastBuildStatus !== undefined) p.lastBuildStatus = project.lastBuildStatus;
    if (project.webhookSecretEnc !== undefined) p.webhookSecretEnc = project.webhookSecretEnc;
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
    const r: PipelineRunMetadata = {
      id: run.id || uuidv4(),
      projectId: run.projectId || '',
      commitSha: run.commitSha || '',
      ref: run.ref || '',
      status: run.status || 'queued',
      startedAt: run.startedAt || new Date().toISOString(),
    };
    if (run.imageTag !== undefined) r.imageTag = run.imageTag;
    if (run.logFile !== undefined) r.logFile = run.logFile;
    if (run.temporalWorkflowId !== undefined) r.temporalWorkflowId = run.temporalWorkflowId;
    if (run.finishedAt !== undefined) r.finishedAt = run.finishedAt;
    if (run.errorMessage !== undefined) r.errorMessage = run.errorMessage;
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
    return this.users.find(u => u.email.trim().toLowerCase() === cleanEmail);
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
