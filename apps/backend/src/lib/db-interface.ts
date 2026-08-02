import { MemoryDB } from './memory-db.js';
import { MongoDB } from './mongo-db.js';
import type { Card } from './board.js';
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

  getCards(): Promise<Card[]>;
  saveCard(card: Card): Promise<void>;
  deleteCard(id: string): Promise<void>;

  getModelEndpoints(): Promise<ModelEndpointMetadata[]>;
  saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void>;
  deleteModelEndpoint(id: string): Promise<void>;
}

export function createDatabase(): Database {
  if (process.env.NODE_ENV === 'test' && !process.env.IS_E2E) {
    return new MemoryDB();
  }
  return new MongoDB();
}