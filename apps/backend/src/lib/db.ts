import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import type { ClusterMetadata, DeploymentMetadata, UserMetadata } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '../../data');

export class LocalDB {
  private readonly isTest = process.env.NODE_ENV === 'test' || process.env.IS_E2E === 'true';
  private readonly clustersPath = path.join(DATA_DIR, `${this.isTest ? 'clusters-test' : 'clusters'}.json`);
  private readonly deploymentsPath = path.join(DATA_DIR, `${this.isTest ? 'deployments-test' : 'deployments'}.json`);
  private readonly usersPath = path.join(DATA_DIR, `${this.isTest ? 'users-test' : 'users'}.json`);

  async init(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    if (!(await this.exists(this.clustersPath))) await fs.writeFile(this.clustersPath, '[]');
    if (!(await this.exists(this.deploymentsPath))) await fs.writeFile(this.deploymentsPath, '[]');
    if (!(await this.exists(this.usersPath))) await fs.writeFile(this.usersPath, '[]');
  }

  private async exists(filePath: string): Promise<boolean> {
    try { await fs.access(filePath); return true; } catch { return false; }
  }

  async getClusters(): Promise<ClusterMetadata[]> {
    const data = await fs.readFile(this.clustersPath, 'utf-8');
    const parsed = JSON.parse(data);
    return parsed || [];
  }

  async saveCluster(cluster: ClusterMetadata): Promise<void> {
    const clusters = await this.getClusters();
    const idx = clusters.findIndex(c => c.id === cluster.id);
    if (idx >= 0) clusters[idx] = cluster;
    else clusters.push(cluster);
    await fs.writeFile(this.clustersPath, JSON.stringify(clusters, null, 2));
  }

  async saveClusterList(clusters: ClusterMetadata[]): Promise<void> {
    await fs.writeFile(this.clustersPath, JSON.stringify(clusters, null, 2));
  }

  async getDeployments(): Promise<DeploymentMetadata[]> {
    const data = await fs.readFile(this.deploymentsPath, 'utf-8');
    const parsed = JSON.parse(data);
    return parsed || [];
  }

  async saveDeployment(deployment: DeploymentMetadata): Promise<void> {
    const deployments = await this.getDeployments();
    const idx = deployments.findIndex(d => d.id === deployment.id);
    if (idx >= 0) deployments[idx] = deployment;
    else deployments.push(deployment);
    await fs.writeFile(this.deploymentsPath, JSON.stringify(deployments, null, 2));
  }

  async saveDeploymentList(deployments: DeploymentMetadata[]): Promise<void> {
    await fs.writeFile(this.deploymentsPath, JSON.stringify(deployments, null, 2));
  }

  /**
   * Create a new cluster entry (used by TemporalService on workflow kickoff).
   */
  async saveClusterInfo(cluster: Partial<ClusterMetadata>): Promise<ClusterMetadata> {
    const c: ClusterMetadata = {
      id: cluster.id || uuidv4(),
      name: cluster.name || '',
      provider: cluster.provider || 'k3d',
      status: cluster.status || 'provisioning',
      kubeconfigPath: cluster.kubeconfigPath ?? undefined,
      lastLogPath: cluster.lastLogPath ?? undefined,
      temporalWorkflowId: cluster.temporalWorkflowId ?? undefined,
    };
    await this.saveCluster(c);
    return c;
  }

  async saveDeploymentInfo(deployment: Partial<DeploymentMetadata>): Promise<DeploymentMetadata> {
    const d: DeploymentMetadata = {
      id: deployment.id || uuidv4(),
      name: deployment.name || '',
      deploymentId: deployment.deploymentId,
      clusterId: deployment.clusterId || '',
      strategy: deployment.strategy || 'helm',
      appType: deployment.appType ?? undefined,
      status: deployment.status || 'deploying',
      webRepo: deployment.webRepo,
      webTag: deployment.webTag,
      dbRepo: deployment.dbRepo,
      dbTag: deployment.dbTag,
      url: deployment.url,
      isExposed: deployment.isExposed,
      exposureUrl: deployment.exposureUrl,
      lastLogPath: deployment.lastLogPath,
      modules: deployment.modules,
      storage: deployment.storage,
      vpnEnabled: deployment.vpnEnabled,
      vpnProtocol: deployment.vpnProtocol,
      vpnConfig: deployment.vpnConfig,
      vpnDedicatedIp: deployment.vpnDedicatedIp,
      temporalWorkflowId: deployment.temporalWorkflowId,
    };
    await this.saveDeployment(d);
    return d;
  }

  async getUsers(): Promise<UserMetadata[]> {
    const data = await fs.readFile(this.usersPath, 'utf-8');
    const parsed = JSON.parse(data);
    return parsed || [];
  }

  async saveUser(user: UserMetadata): Promise<void> {
    const users = await this.getUsers();
    const idx = users.findIndex(u => u.id === user.id);
    if (idx >= 0) users[idx] = user;
    else users.push(user);
    await fs.writeFile(this.usersPath, JSON.stringify(users, null, 2));
  }

  async saveUserList(users: UserMetadata[]): Promise<void> {
    await fs.writeFile(this.usersPath, JSON.stringify(users, null, 2));
  }

  async getUserByEmail(email: string): Promise<UserMetadata | undefined> {
    const users = await this.getUsers();
    const cleanEmail = email.trim().toLowerCase();
    return users.find(u => u.email.trim().toLowerCase() === cleanEmail);
  }

  async getUserById(id: string): Promise<UserMetadata | undefined> {
    const users = await this.getUsers();
    return users.find(u => u.id === id);
  }
}
