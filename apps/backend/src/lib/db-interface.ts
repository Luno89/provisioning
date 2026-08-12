import type { Persona } from '@koala/harness-types';
import { MemoryDB } from './memory-db.js';
import { MongoDB } from './mongo-db.js';
import type { Branch, Leaf } from './leaves.js';
import type { Tree } from './trees.js';
import type { GiteaAccount } from './projects.js';
import type { Experiment } from './experiments.js';
import type { HarnessProfile } from './harness-profile.js';
import type { MemoryItem } from './memory-store.js';
import type { ToolRepositoryItem } from './tool-repository.js';
import type { ModelThinkingProfile } from './thinking-classifier.js';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, UserMetadata, ProjectMetadata, PipelineRunMetadata, InviteMetadata, ModelEndpointMetadata } from './types.js';

/**
 * Like Partial<T>, but each property may also be *explicitly* undefined.
 *
 * Under exactOptionalPropertyTypes, `Partial<T>` means "the key may be absent", NOT "the value may
 * be undefined" — so `{ storage: maybeUndefined }` is rejected. Every `save*Info` implementation
 * already filters with `if (x !== undefined)` before writing, so passing an explicit undefined is
 * both safe and the natural thing every caller does when spreading optional values.
 */
export type PartialInfo<T> = { [K in keyof T]?: T[K] | undefined };

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
  /** Removes one deployment, rather than rewriting the whole collection to drop it. */
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

  /** Keyed by ownerId — the promoted harness settings in force for one user. */
  getHarnessProfile(ownerId: string): Promise<HarnessProfile | null>;
  saveHarnessProfile(profile: HarnessProfile): Promise<void>;

  /** Owner-filtered by the caller, like leaves and experiments — never trust the id alone. */
  getPersonas(): Promise<Persona[]>;
  savePersona(persona: Persona): Promise<void>;
  deletePersona(id: string): Promise<void>;
  deleteHarnessProfile(ownerId: string): Promise<void>;

  /** Keyed by ownerId — one Gitea account per platform user. */
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

  getModelEndpoints(): Promise<ModelEndpointMetadata[]>;
  saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void>;
  deleteModelEndpoint(id: string): Promise<void>;

  getMemories(ownerId?: string): Promise<MemoryItem[]>;
  saveMemory(memory: MemoryItem): Promise<void>;
  deleteMemory(id: string): Promise<void>;

  getTools(): Promise<ToolRepositoryItem[]>;
  saveTool(tool: ToolRepositoryItem): Promise<void>;
  deleteTool(id: string): Promise<void>;

  getModelThinkingProfile?(modelId: string): Promise<ModelThinkingProfile | null>;
  saveModelThinkingProfile?(profile: ModelThinkingProfile): Promise<void>;
}

export function createDatabase(): Database {
  if (process.env.NODE_ENV === 'test' && !process.env.IS_E2E) {
    return new MemoryDB();
  }
  return new MongoDB();
}