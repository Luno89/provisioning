import { v4 as uuidv4 } from 'uuid';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, UserMetadata } from './types.js';
import type { Database } from './db-interface.js';

export class MemoryDB implements Database {
  private clusters: ClusterMetadata[] = [];
  private deployments: DeploymentMetadata[] = [];
  private users: UserMetadata[] = [];

  async init(): Promise<void> {
    this.clusters = [];
    this.deployments = [];
    this.users = [];
  }

  async close(): Promise<void> {
    this.clusters = [];
    this.deployments = [];
    this.users = [];
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

  async saveClusterInfo(cluster: Partial<ClusterMetadata>): Promise<ClusterMetadata> {
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
    await this.saveCluster(c);
    return c;
  }

  async updateClusterProgress(clusterId: string, progress: ClusterProgress): Promise<void> {
    const idx = this.clusters.findIndex(c => c.id === clusterId);
    if (idx >= 0) {
      this.clusters[idx] = { ...this.clusters[idx], progress };
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

  async saveDeploymentList(deployments: DeploymentMetadata[]): Promise<void> {
    this.deployments = [...deployments];
  }

  async saveDeploymentInfo(deployment: Partial<DeploymentMetadata>): Promise<DeploymentMetadata> {
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
    if (deployment.openWebuiTargetId !== undefined) d.openWebuiTargetId = deployment.openWebuiTargetId;
    await this.saveDeployment(d);
    return d;
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
}