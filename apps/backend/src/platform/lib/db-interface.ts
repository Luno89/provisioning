import type { Conversation } from '../../engine/lib/conversations.js';
import type { StoredAppSpec } from '../../infrastructure/lib/app-spec.js';
import type { McpToolHint } from '../../engine/lib/mcp-tool-hints.js';
import type { BenchSettings, BenchState } from '../../checks/lib/bench.js';
import { MongoDB } from './mongo-db.js';
import { mongoPayloadBlobs } from './mongo-payload-blobs.js';
import { inMemoryPayloadBlobs, type PayloadBlobs } from './payload-storage.js';
import type { Branch, Leaf } from '../../projects/lib/leaves.js';
import type { Tree } from '../../projects/lib/trees.js';
import type { CorpusPage } from '../../engine/lib/corpus.js';
import type { FrontierUrl, FrontierClaim } from './frontier.js';
import type { GiteaAccount } from '../../projects/lib/projects.js';
import type { MemoryItem } from '../../memory/lib/memory-store.js';
import type { Task } from '../../projects/lib/tasks.js';
import type { PlanProposal } from '../../projects/lib/plan-proposals.js';
import { markingHubWrites } from '../../hub/lib/hub-sync.js';
import type { HubStore } from '../../hub/store.js';
import type { AccountsStore } from '../../accounts/store.js';
import type { PlatformStore } from '../store.js';
import type { SecretRequest } from '../../projects/lib/secret-requests.js';
import type { AccessRequest, ActionProposal, EgressGrantRecord, EgressRequest, McpRequest } from '@koala/harness-types';
import type { ExtensionSettings } from '../../engine/lib/extension-settings.js';
import type { AutoModeSettings } from '../../engine/lib/auto-mode.js';
import type { MonitoringSetting, AlertEpisode } from '../../monitoring/lib/monitoring-records.js';
import type { AlertRuleRecord } from '../../monitoring/lib/monitoring-alerts.js';
import type { NotificationSettings } from './mail.js';
import type { FileSettings } from '../../files/lib/file-places.js';
import type { FileShare } from '../../files/lib/file-shares.js';
import type { PoolPolicy } from '../../instances/lib/pool.js';
import type { WorkFailure } from '../../infrastructure/lib/work-failures.js';
import type { AuthoredExtension } from '../../engine/lib/authored-extensions.js';
import type { InstanceRecord, JoinToken } from '../../instances/lib/instances.js';
import type { MachineJoinCode } from '../../machines/lib/machines.js';
import type { ProcedureSource } from '../../engine/lib/procedure-source.js';
import type { StoredNodeTrace } from '../../engine/lib/run-traces.js';
import type { RunMark, TurnLogEntry } from '../../engine/lib/turn-log.js';
import type { RunEffort } from '@koala/agent-engine/procedure';
import type { GrantKind, PersonaRecord as EnginePersona, ToolDefinition as EngineTool, ToolGrant, WorkspaceDependency } from '@koala/agent-engine';
import type { PublishedWorkspace } from '../../engine/lib/published-workspace.js';
import type { McpServerRecord } from '../../engine/lib/mcp-servers.js';
import type { EvalCollection, EvalRecord } from '../../checks/lib/eval-run.js';
import type { TreeTypeSpec } from '../../projects/lib/tree-types.js';
import type { WorkspaceImageSpec } from '../../engine/lib/workspace-image-seeds.js';
import type { ModelThinkingProfile } from '../../engine/lib/thinking-classifier.js';
import type { ClusterProviderSpec } from '../../infrastructure/lib/cluster-providers.js';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, ProjectMetadata, PipelineRunMetadata, ModelEndpointMetadata, LocalAgentDeviceMetadata, PendingApprovalMetadata } from './types.js';
import type { OdooRelease } from '../../releases/lib/odoo-release.js';
import type { StoredArtifact } from '../../files/lib/artifacts.js';
import type { ArtifactChunk } from '../../files/lib/artifacts.js';
import type { DeferredConclusion, KeeperSettings } from '../../memory/lib/conclusions.js';

export type PartialInfo<T> = { [K in keyof T]?: T[K] | undefined };

export interface BindingTypeRecord {
  id: string;
  label: string;
  appType?: string | undefined;
  protocol?: 'http' | 'https' | 'tcp' | 'grpc' | undefined;
  defaultPort?: number | undefined;
  description?: string | undefined;
  requiredKeys?: string[] | undefined;
}

export interface SecretRequestFilter {
  conversationId?: string | undefined;
  projectId?: string | undefined;
  treeId?: string | undefined;
}

export interface ScriptedRequestRecord {
  ownerId: string;
  at: string;
  text: string;
  tools: string[];
  rule?: number | undefined;
  miss?: string | undefined;
}

export interface Database {
  hub: HubStore;
  accounts: AccountsStore;
  platform: PlatformStore;
  init(): Promise<void>;
  close(): Promise<void>;

  getClusters(): Promise<ClusterMetadata[]>;
  saveCluster(cluster: ClusterMetadata): Promise<void>;
  saveClusterList(clusters: ClusterMetadata[]): Promise<void>;
  saveClusterInfo(cluster: PartialInfo<ClusterMetadata>): Promise<ClusterMetadata>;
  updateClusterProgress(clusterId: string, progress: ClusterProgress): Promise<void>;

  getDeployments(): Promise<DeploymentMetadata[]>;
  saveDeployment(deployment: DeploymentMetadata): Promise<void>;
  saveDeploymentList(deployments: DeploymentMetadata[]): Promise<void>;
  deleteDeployment(id: string): Promise<void>;
  saveDeploymentInfo(deployment: PartialInfo<DeploymentMetadata>): Promise<DeploymentMetadata>;

  removeProjectRecords(projectId: string): Promise<Record<string, number>>;
  findRunEffort(runId: string): Promise<RunEffort | undefined>;
  saveScriptedRequest(request: ScriptedRequestRecord): Promise<void>;
  getScriptedRequests(ownerId: string): Promise<ScriptedRequestRecord[]>;
  reownRuns(from: string, to: string, runIds?: readonly string[] | undefined): Promise<number>;

  getProjects(): Promise<ProjectMetadata[]>;
  saveProject(project: ProjectMetadata): Promise<void>;
  saveProjectInfo(project: PartialInfo<ProjectMetadata>): Promise<ProjectMetadata>;

  getPipelineRuns(): Promise<PipelineRunMetadata[]>;
  savePipelineRun(run: PipelineRunMetadata): Promise<void>;
  savePipelineRunInfo(run: PartialInfo<PipelineRunMetadata>): Promise<PipelineRunMetadata>;

  getWorkspaceImages(ownerId?: string): Promise<WorkspaceImageSpec[]>;
  saveWorkspaceImage(image: WorkspaceImageSpec): Promise<void>;

  getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
  saveTreeType(treeType: TreeTypeSpec): Promise<void>;
  deleteTreeType(id: string, ownerId: string): Promise<void>;

  getGiteaAccount(ownerId: string): Promise<GiteaAccount | null>;
  saveGiteaAccount(account: GiteaAccount): Promise<void>;

  getCorpusPages(filter: { ownerId: string; ingestId?: string; projectId?: string }): Promise<CorpusPage[]>;
  saveCorpusPages(pages: CorpusPage[]): Promise<void>;
  deleteCorpus(ingestId: string): Promise<void>;

  enqueueFrontier(urls: FrontierUrl[]): Promise<number>;
  claimFrontier(ingestId: string, limit: number): Promise<FrontierClaim[]>;
  completeFrontier(ingestId: string, urls: string[]): Promise<void>;
  countFrontier(ingestId: string): Promise<number>;
  deleteFrontier(ingestId: string): Promise<void>;

  getTrees(): Promise<Tree[]>;
  saveTree(tree: Tree): Promise<void>;
  deleteTree(id: string): Promise<void>;

  getBranches(): Promise<Branch[]>;
  saveBranch(branch: Branch): Promise<void>;
  deleteBranch(id: string): Promise<void>;

  getAppSpecs(): Promise<StoredAppSpec[]>;
  saveAppSpec(spec: StoredAppSpec): Promise<void>;
  deleteAppSpec(id: string): Promise<void>;

  getClusterProviders(): Promise<ClusterProviderSpec[]>;
  saveClusterProvider(provider: ClusterProviderSpec): Promise<void>;

  getConversations(): Promise<Conversation[]>;
  getConversation(ownerId: string, id: string): Promise<Conversation | undefined>;
  allowToolInConversation(ownerId: string, conversationId: string, tool: string): Promise<boolean>;
  setConversationAutoMode(ownerId: string, conversationId: string, on: boolean): Promise<boolean>;
  bindConversation(ownerId: string, conversationId: string, binding: { treeId: string; projectId?: string | undefined }): Promise<boolean>;
  appendNotice(ownerId: string, conversationId: string, message: import('../../engine/lib/conversations.js').ConversationMessage): Promise<boolean>;
  appendMessage(ownerId: string, conversationId: string, message: import('../../engine/lib/conversations.js').ConversationMessage): Promise<boolean>;
  ownsRun(ownerId: string, runId: string): Promise<boolean>;
  runOrigin(ownerId: string, runId: string): Promise<{ agentId?: string | undefined; turnId: string } | undefined>;
  saveConversation(conversation: Conversation): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  getLeaves(): Promise<Leaf[]>;
  saveLeaf(leaf: Leaf): Promise<void>;
  deleteLeaf(id: string): Promise<void>;

  getModelEndpoints(): Promise<ModelEndpointMetadata[]>;
  saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void>;
  deleteModelEndpoint(id: string): Promise<void>;

  getLocalAgentDevices(): Promise<LocalAgentDeviceMetadata[]>;
  saveLocalAgentDevice(device: LocalAgentDeviceMetadata): Promise<void>;
  deleteLocalAgentDevice(id: string): Promise<void>;

  getPendingApprovals(): Promise<PendingApprovalMetadata[]>;
  savePendingApproval(approval: PendingApprovalMetadata): Promise<void>;
  deletePendingApproval(id: string): Promise<void>;

  getMemories(ownerId?: string): Promise<MemoryItem[]>;
  saveMemory(memory: MemoryItem): Promise<void>;

  getTasks(ownerId?: string): Promise<Task[]>;
  saveTask(task: Task): Promise<void>;
  deleteTask(id: string): Promise<void>;

  getPlanProposals(ownerId: string, conversationId?: string): Promise<PlanProposal[]>;
  getPlanProposal(ownerId: string, id: string): Promise<PlanProposal | undefined>;
  savePlanProposal(proposal: PlanProposal): Promise<void>;
  deletePlanProposal(ownerId: string, id: string): Promise<void>;

  getOdooReleases(ownerId: string, projectId?: string): Promise<OdooRelease[]>;
  saveArtifact(artifact: StoredArtifact): Promise<void>;
  getArtifacts(ownerId: string, runId?: string): Promise<StoredArtifact[]>;
  getExpiredArtifacts(now: string): Promise<StoredArtifact[]>;
  deleteArtifact(id: string): Promise<void>;
  saveArtifactChunk(chunk: ArtifactChunk): Promise<void>;
  getArtifactChunks(artifactId: string): Promise<ArtifactChunk[]>;
  deleteArtifactChunks(artifactId: string): Promise<void>;
  saveOdooRelease(release: OdooRelease): Promise<void>;
  getSecretRequests(ownerId: string, filter?: SecretRequestFilter): Promise<SecretRequest[]>;
  getSecretRequest(ownerId: string, id: string): Promise<SecretRequest | undefined>;
  saveSecretRequest(request: SecretRequest): Promise<void>;
  deleteSecretRequest(ownerId: string, id: string): Promise<void>;

  getMcpRequests(ownerId: string, conversationId?: string): Promise<McpRequest[]>;
  getMcpRequest(ownerId: string, id: string): Promise<McpRequest | undefined>;
  saveMcpRequest(request: McpRequest): Promise<void>;
  getMcpToolHints(ownerId: string): Promise<McpToolHint[]>;
  getKeeperSettings(ownerId: string): Promise<KeeperSettings | undefined>;
  saveKeeperSettings(settings: KeeperSettings): Promise<void>;
  getDeferredConclusions(ownerId: string): Promise<DeferredConclusion[]>;
  saveDeferredConclusion(deferred: DeferredConclusion): Promise<void>;
  deleteDeferredConclusion(ownerId: string, id: string): Promise<void>;
  getMemoryWatermark(key: string): Promise<string | undefined>;
  getBenchSettings(ownerId: string): Promise<BenchSettings | undefined>;
  saveBenchSettings(ownerId: string, settings: BenchSettings): Promise<void>;
  getBenchState(ownerId: string): Promise<BenchState | undefined>;
  saveBenchState(state: BenchState): Promise<void>;
  saveMemoryWatermark(key: string, value: string): Promise<void>;
  deleteMcpToolHint(ownerId: string, server: string, tool: string): Promise<void>;

  getActionProposals(ownerId: string, filter?: { conversationId?: string | undefined; treeId?: string | undefined }): Promise<ActionProposal[]>;
  getActionProposal(ownerId: string, id: string): Promise<ActionProposal | undefined>;
  saveActionProposal(proposal: ActionProposal): Promise<void>;

  getExtensionSettings(ownerId: string): Promise<ExtensionSettings | undefined>;
  getAuthoredExtensions(ownerId: string): Promise<AuthoredExtension[]>;
  claimHandoff(jti: string, expiresAt: string): Promise<boolean>;
  saveJoinToken(token: JoinToken): Promise<void>;
  takeJoinToken(hash: string): Promise<JoinToken | undefined>;
  saveMachineJoinCode(code: MachineJoinCode): Promise<void>;
  takeMachineJoinCode(hash: string): Promise<MachineJoinCode | undefined>;
  getInstances(ownerId?: string): Promise<InstanceRecord[]>;
  saveInstance(instance: InstanceRecord): Promise<void>;
  deleteInstance(id: string): Promise<void>;
  saveAuthoredExtension(extension: AuthoredExtension): Promise<void>;
  deleteAuthoredExtension(ownerId: string, id: string): Promise<void>;
  saveExtensionSettings(settings: ExtensionSettings): Promise<void>;
  getAutoModeSettings(ownerId: string): Promise<AutoModeSettings | undefined>;
  getMonitoringSettings(): Promise<MonitoringSetting[]>;
  getNotificationSettings(ownerId: string): Promise<NotificationSettings | undefined>;
  saveNotificationSettings(settings: NotificationSettings): Promise<void>;
  getFileSettings(ownerId: string): Promise<FileSettings | undefined>;
  saveFileSettings(settings: FileSettings): Promise<void>;
  getFileShares(ownerId: string): Promise<FileShare[]>;
  getFileShare(id: string): Promise<FileShare | undefined>;
  saveFileShare(share: FileShare): Promise<void>;
  deleteFileShare(id: string): Promise<void>;
  getPoolPolicy(): Promise<PoolPolicy | undefined>;
  savePoolPolicy(policy: PoolPolicy): Promise<void>;
  saveMonitoringSetting(setting: MonitoringSetting): Promise<void>;
  getAlertRules(ownerId?: string): Promise<AlertRuleRecord[]>;
  saveAlertRule(rule: AlertRuleRecord): Promise<void>;
  deleteAlertRule(id: string): Promise<void>;
  getAlertEpisodes(ownerId?: string): Promise<AlertEpisode[]>;
  saveAlertEpisode(episode: AlertEpisode): Promise<void>;
  getWorkFailures(ownerId?: string): Promise<WorkFailure[]>;
  addWorkFailure(failure: WorkFailure): Promise<void>;
  clearWorkFailures(ownerId: string, ids: readonly string[] | 'all', at: string): Promise<number>;
  pruneWorkFailures(before: string): Promise<void>;
  saveAutoModeSettings(settings: AutoModeSettings): Promise<void>;
  getEgressGrants(ownerId?: string): Promise<EgressGrantRecord[]>;
  saveEgressGrant(grant: EgressGrantRecord): Promise<void>;
  getEgressRequests(ownerId: string, filter?: { conversationId?: string | undefined; treeId?: string | undefined }): Promise<EgressRequest[]>;
  getEgressRequest(ownerId: string, id: string): Promise<EgressRequest | undefined>;
  saveEgressRequest(request: EgressRequest): Promise<void>;

  getAccessRequests(ownerId: string, conversationId?: string): Promise<AccessRequest[]>;
  getAccessRequest(ownerId: string, id: string): Promise<AccessRequest | undefined>;
  saveAccessRequest(request: AccessRequest): Promise<void>;
  deleteMemory(id: string): Promise<void>;

  getProcedure(ownerId: string, id: string): Promise<ProcedureSource | undefined>;
  getProcedures(ownerId?: string): Promise<ProcedureSource[]>;
  saveProcedure(source: ProcedureSource): Promise<void>;
  deleteProcedure(ownerId: string | undefined, id: string): Promise<void>;

  saveRunTraces(traces: StoredNodeTrace[]): Promise<void>;
  getRunTraces(ownerId: string, runId: string): Promise<StoredNodeTrace[]>;
  appendTurnLog(entry: TurnLogEntry): Promise<void>;
  getTurnLog(ownerId: string, turnId: string, after: number): Promise<TurnLogEntry[]>;
  getTurnLogMarks(ownerId: string, turnId: string, types: readonly string[]): Promise<RunMark[]>;
  lastTurnLogSeq(turnId: string): Promise<number>;
  recentTurns(ownerId: string, since: string, limit: number): Promise<TurnLogEntry[]>;
  saveRunEffort(effort: RunEffort): Promise<void>;
  getRunEffort(ownerId: string, procedureId: string, modelKey?: string): Promise<RunEffort[]>;

  getEnginePersonas(ownerId?: string): Promise<EnginePersona[]>;
  saveEnginePersona(persona: EnginePersona): Promise<void>;
  deleteEnginePersona(ownerId: string | undefined, slug: string): Promise<void>;

  getPublishedWorkspace(ownerId: string, treeId: string): Promise<PublishedWorkspace | undefined>;
  getPublishedWorkspaces(ownerId: string): Promise<PublishedWorkspace[]>;
  savePublishedWorkspace(workspace: PublishedWorkspace): Promise<void>;
  deletePublishedWorkspace(ownerId: string, treeId: string): Promise<void>;
  getMcpServers(ownerId: string): Promise<McpServerRecord[]>;
  saveMcpServer(server: McpServerRecord): Promise<void>;
  deleteMcpServer(ownerId: string, id: string): Promise<void>;
  getWorkspaceDependencies(ownerId: string): Promise<WorkspaceDependency[]>;
  saveWorkspaceDependency(dependency: WorkspaceDependency & { ownerId: string }): Promise<void>;
  deleteWorkspaceDependency(ownerId: string, name: string): Promise<void>;

  getToolGrants(ownerId: string): Promise<ToolGrant[]>;
  saveToolGrant(grant: ToolGrant & { ownerId: string }): Promise<void>;
  deleteToolGrant(ownerId: string, agent: string, tool: string, kind?: GrantKind | undefined): Promise<void>;
  deleteToolGrantsFor(ownerId: string | undefined, of: { agent?: string; tool?: string; kind?: GrantKind | undefined }): Promise<number>;

  getEngineTools(ownerId?: string): Promise<EngineTool[]>;
  saveEngineTool(tool: EngineTool): Promise<void>;
  deleteEngineTool(ownerId: string | undefined, name: string): Promise<void>;

  getEvalRecords<T extends EvalRecord>(collection: EvalCollection, ownerId: string, limit?: number): Promise<T[]>;
  getEvalRecordsInState<T extends EvalRecord>(collection: EvalCollection, state: string): Promise<T[]>;
  getEvalRecord<T extends EvalRecord>(collection: EvalCollection, ownerId: string, id: string): Promise<T | null>;
  saveEvalRecord<T extends EvalRecord>(collection: EvalCollection, record: T): Promise<void>;
  deleteEvalRecord(collection: EvalCollection, ownerId: string, id: string): Promise<void>;

  getBindingTypes(): Promise<BindingTypeRecord[]>;
  saveBindingType(record: BindingTypeRecord): Promise<void>;
  deleteBindingType(id: string): Promise<void>;

  getModelThinkingProfile?(modelId: string): Promise<ModelThinkingProfile | null>;
  saveModelThinkingProfile?(profile: ModelThinkingProfile): Promise<void>;
}

let payloadBlobs: PayloadBlobs | undefined;

export function sharedPayloadBlobs(): PayloadBlobs {
  if (!payloadBlobs) {
    const inMemory = process.env.NODE_ENV === 'test' && !process.env.IS_E2E;
    payloadBlobs = inMemory ? inMemoryPayloadBlobs() : mongoPayloadBlobs();
  }
  return payloadBlobs;
}

export function createDatabase(env: Readonly<Record<string, string | undefined>> = process.env): Database {
  const db = new MongoDB(env);
  return markingHubWrites(db, db.hub);
}