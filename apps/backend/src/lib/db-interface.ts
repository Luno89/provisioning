import { MemoryDB } from './memory-db.js';
import { MongoDB } from './mongo-db.js';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, UserMetadata } from './types.js';

export interface Database {
  init(): Promise<void>;
  close(): Promise<void>;

  getClusters(): Promise<ClusterMetadata[]>;
  saveCluster(cluster: ClusterMetadata): Promise<void>;
  saveClusterList(clusters: ClusterMetadata[]): Promise<void>;
  saveClusterInfo(cluster: Partial<ClusterMetadata>): Promise<ClusterMetadata>;
  updateClusterProgress(clusterId: string, progress: ClusterProgress): Promise<void>;

  getDeployments(): Promise<DeploymentMetadata[]>;
  saveDeployment(deployment: DeploymentMetadata): Promise<void>;
  saveDeploymentList(deployments: DeploymentMetadata[]): Promise<void>;
  saveDeploymentInfo(deployment: Partial<DeploymentMetadata>): Promise<DeploymentMetadata>;

  getUsers(): Promise<UserMetadata[]>;
  saveUser(user: UserMetadata): Promise<void>;
  saveUserList(users: UserMetadata[]): Promise<void>;
  getUserByEmail(email: string): Promise<UserMetadata | undefined>;
  getUserById(id: string): Promise<UserMetadata | undefined>;
}

export function createDatabase(): Database {
  if (process.env.NODE_ENV === 'test' && !process.env.IS_E2E) {
    return new MemoryDB();
  }
  return new MongoDB();
}