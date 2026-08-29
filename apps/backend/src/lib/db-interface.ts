import type { Persona, PersonaPack } from '@koala/harness-types';
import type { Conversation } from './conversations.js';
import type { StoredAppSpec } from './app-spec.js';
import { MemoryDB } from './memory-db.js';
import { MongoDB } from './mongo-db.js';
import type { Branch, Leaf } from './leaves.js';
import type { Tree } from './trees.js';
import type { CorpusPage } from './corpus.js';
import type { FrontierUrl, FrontierClaim } from './frontier.js';
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
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, UserMetadata, ProjectMetadata, PipelineRunMetadata, InviteMetadata, ModelEndpointMetadata } from './types.js';

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

export interface Database {
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

  getUsers(): Promise<UserMetadata[]>;
  saveUser(user: UserMetadata): Promise<void>;
  saveUserList(users: UserMetadata[]): Promise<void>;
  getUserByEmail(email: string): Promise<UserMetadata | undefined>;
  getUserById(id: string): Promise<UserMetadata | undefined>;

  getProjects(): Promise<ProjectMetadata[]>;
  saveProject(project: ProjectMetadata): Promise<void>;
  saveProjectInfo(project: PartialInfo<ProjectMetadata>): Promise<ProjectMetadata>;

  getPipelineRuns(): Promise<PipelineRunMetadata[]>;
  savePipelineRun(run: PipelineRunMetadata): Promise<void>;
  savePipelineRunInfo(run: PartialInfo<PipelineRunMetadata>): Promise<PipelineRunMetadata>;

  getInvites(): Promise<InviteMetadata[]>;
  saveInvite(invite: InviteMetadata): Promise<void>;

  getExperiments(): Promise<Experiment[]>;
  saveExperiment(experiment: Experiment): Promise<void>;
  deleteExperiment(id: string): Promise<void>;

  getHarnessProfile(ownerId: string): Promise<HarnessProfile | null>;
  saveHarnessProfile(profile: HarnessProfile): Promise<void>;

  getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
  saveTreeType(treeType: TreeTypeSpec): Promise<void>;
  deleteTreeType(id: string, ownerId: string): Promise<void>;

  getPersonas(): Promise<Persona[]>;
  savePersona(persona: Persona): Promise<void>;
  deletePersona(id: string): Promise<void>;

  getPersonaPacks(): Promise<PersonaPack[]>;
  savePersonaPack(pack: PersonaPack): Promise<void>;
  deletePersonaPack(id: string): Promise<void>;
  deleteHarnessProfile(ownerId: string): Promise<void>;

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

  getLeafTrace(leafId: string): Promise<LeafTrace | null>;
  saveLeafTrace(trace: LeafTrace): Promise<void>;
  appendLeafStep(trace: Omit<LeafTrace, 'steps'> & { step: AgentStep }): Promise<void>;
  saveLeafEvidence(leafId: string, evidence: LeafEvidence): Promise<void>;
  deleteLeafTrace(leafId: string): Promise<void>;

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
  saveConversation(conversation: Conversation): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  getLeaves(): Promise<Leaf[]>;
  saveLeaf(leaf: Leaf): Promise<void>;
  deleteLeaf(id: string): Promise<void>;

  getModelEndpoints(): Promise<ModelEndpointMetadata[]>;
  saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void>;
  deleteModelEndpoint(id: string): Promise<void>;

  getMemories(ownerId?: string): Promise<MemoryItem[]>;
  saveMemory(memory: MemoryItem): Promise<void>;
  deleteMemory(id: string): Promise<void>;

  getBindingTypes(): Promise<BindingTypeRecord[]>;
  saveBindingType(record: BindingTypeRecord): Promise<void>;
  deleteBindingType(id: string): Promise<void>;

  getTools(): Promise<ToolRepositoryItem[]>;
  saveTool(tool: ToolRepositoryItem): Promise<void>;
  deleteTool(id: string): Promise<void>;

  getModelThinkingProfile?(modelId: string): Promise<ModelThinkingProfile | null>;
  saveModelThinkingProfile?(profile: ModelThinkingProfile): Promise<void>;
}

export function createDatabase(): Database {
  if (process.env.USE_MEMORY_DB === 'true' || (process.env.NODE_ENV === 'test' && !process.env.IS_E2E)) {
    return new MemoryDB();
  }
  return new MongoDB();
}