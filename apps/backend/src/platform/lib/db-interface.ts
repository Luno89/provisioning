import type { Conversation } from '../../engine/lib/conversations.js';
import type { StoredAppSpec } from '../../infrastructure/lib/app-spec.js';
import type { McpToolHint } from '../../engine/lib/mcp-tool-hints.js';
import { MongoDB } from './mongo-db.js';
import { mongoPayloadBlobs } from './mongo-payload-blobs.js';
import { inMemoryPayloadBlobs, type PayloadBlobs } from './payload-storage.js';
import type { CorpusPage } from '../../engine/lib/corpus.js';
import type { FrontierUrl, FrontierClaim } from './frontier.js';
import { markingHubWrites } from '../../hub/lib/hub-sync.js';
import type { HubStore } from '../../hub/store.js';
import type { ChecksStore } from '../../checks/store.js';
import type { MemoryStore } from '../../memory/store.js';
import type { ModelsStore } from '../../models/store.js';
import type { MonitoringStore } from '../../monitoring/store.js';
import type { MachinesStore } from '../../machines/store.js';
import type { FilesStore } from '../../files/store.js';
import type { ReleasesStore } from '../../releases/store.js';
import type { ProjectsStore } from '../../projects/store.js';
import type { InstancesStore } from '../../instances/store.js';
import type { AccountsStore } from '../../accounts/store.js';
import type { PlatformStore } from '../store.js';
import type { AccessRequest, ActionProposal, EgressGrantRecord, EgressRequest, McpRequest } from '@koala/harness-types';
import type { ExtensionSettings } from '../../engine/lib/extension-settings.js';
import type { AutoModeSettings } from '../../engine/lib/auto-mode.js';
import type { WorkFailure } from '../../infrastructure/lib/work-failures.js';
import type { AuthoredExtension } from '../../engine/lib/authored-extensions.js';
import type { ProcedureSource } from '../../engine/lib/procedure-source.js';
import type { StoredNodeTrace } from '../../engine/lib/run-traces.js';
import type { RunMark, TurnLogEntry } from '../../engine/lib/turn-log.js';
import type { RunEffort } from '@koala/agent-engine/procedure';
import type { GrantKind, PersonaRecord as EnginePersona, ToolDefinition as EngineTool, ToolGrant, WorkspaceDependency } from '@koala/agent-engine';
import type { PublishedWorkspace } from '../../engine/lib/published-workspace.js';
import type { McpServerRecord } from '../../engine/lib/mcp-servers.js';
import type { WorkspaceImageSpec } from '../../engine/lib/workspace-image-seeds.js';
import type { ClusterProviderSpec } from '../../infrastructure/lib/cluster-providers.js';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, PendingApprovalMetadata } from './types.js';
import type { PartialInfo } from './types.js';

export interface BindingTypeRecord {
  id: string;
  label: string;
  appType?: string | undefined;
  protocol?: 'http' | 'https' | 'tcp' | 'grpc' | undefined;
  defaultPort?: number | undefined;
  description?: string | undefined;
  requiredKeys?: string[] | undefined;
}

export interface Database {
  hub: HubStore;
  checks: ChecksStore;
  memory: MemoryStore;
  models: ModelsStore;
  monitoring: MonitoringStore;
  machines: MachinesStore;
  files: FilesStore;
  releases: ReleasesStore;
  projects: ProjectsStore;
  instances: InstancesStore;
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

  findRunEffort(runId: string): Promise<RunEffort | undefined>;
  reownRuns(from: string, to: string, runIds?: readonly string[] | undefined): Promise<number>;

  getWorkspaceImages(ownerId?: string): Promise<WorkspaceImageSpec[]>;
  saveWorkspaceImage(image: WorkspaceImageSpec): Promise<void>;

  getCorpusPages(filter: { ownerId: string; ingestId?: string; projectId?: string }): Promise<CorpusPage[]>;
  saveCorpusPages(pages: CorpusPage[]): Promise<void>;
  deleteCorpus(ingestId: string): Promise<void>;

  enqueueFrontier(urls: FrontierUrl[]): Promise<number>;
  claimFrontier(ingestId: string, limit: number): Promise<FrontierClaim[]>;
  completeFrontier(ingestId: string, urls: string[]): Promise<void>;
  countFrontier(ingestId: string): Promise<number>;
  deleteFrontier(ingestId: string): Promise<void>;

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

  getPendingApprovals(): Promise<PendingApprovalMetadata[]>;
  savePendingApproval(approval: PendingApprovalMetadata): Promise<void>;
  deletePendingApproval(id: string): Promise<void>;

  getMcpRequests(ownerId: string, conversationId?: string): Promise<McpRequest[]>;
  getMcpRequest(ownerId: string, id: string): Promise<McpRequest | undefined>;
  saveMcpRequest(request: McpRequest): Promise<void>;
  getMcpToolHints(ownerId: string): Promise<McpToolHint[]>;
  deleteMcpToolHint(ownerId: string, server: string, tool: string): Promise<void>;

  getActionProposals(ownerId: string, filter?: { conversationId?: string | undefined; treeId?: string | undefined }): Promise<ActionProposal[]>;
  getActionProposal(ownerId: string, id: string): Promise<ActionProposal | undefined>;
  saveActionProposal(proposal: ActionProposal): Promise<void>;

  getExtensionSettings(ownerId: string): Promise<ExtensionSettings | undefined>;
  getAuthoredExtensions(ownerId: string): Promise<AuthoredExtension[]>;
  saveAuthoredExtension(extension: AuthoredExtension): Promise<void>;
  deleteAuthoredExtension(ownerId: string, id: string): Promise<void>;
  saveExtensionSettings(settings: ExtensionSettings): Promise<void>;
  getAutoModeSettings(ownerId: string): Promise<AutoModeSettings | undefined>;
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

  getBindingTypes(): Promise<BindingTypeRecord[]>;
  saveBindingType(record: BindingTypeRecord): Promise<void>;
  deleteBindingType(id: string): Promise<void>;

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