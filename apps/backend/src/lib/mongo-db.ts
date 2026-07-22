import { MongoClient, type Db, type Collection, ObjectId } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, UserMetadata } from './types.js';
import type { Database } from './db-interface.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin';

function toBsonId(id: string): ObjectId | string {
  if (ObjectId.isValid(id)) return new ObjectId(id);
  return id;
}

function fromDoc<T extends { id: string }>(doc: Record<string, any>): T {
  const result = { ...doc };
  result.id = result._id.toString();
  const { _id, ...rest } = result;
  return rest as T;
}

function toDoc<T extends { id: string }>(entity: T): Record<string, any> {
  const { id, ...rest } = entity as any;
  return {
    ...rest,
    _id: id,
  };
}

export class MongoDB implements Database {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  private get clusters(): Collection {
    return this.db!.collection('clusters');
  }

  private get deployments(): Collection {
    return this.db!.collection('deployments');
  }

  private get users(): Collection {
    return this.db!.collection('users');
  }

  async init(): Promise<void> {
    const isE2E = process.env.IS_E2E === 'true';
    const uri = isE2E
      ? (process.env.MONGO_TEST_URI || MONGO_URI.replace('/provisioning', '/provisioning_test'))
      : MONGO_URI;

    this.client = new MongoClient(uri);
    await this.client.connect();
    this.db = this.client.db(isE2E ? 'provisioning_test' : 'provisioning');

    if (isE2E) {
      await this.db.dropDatabase();
    }

    await this.clusters.createIndex({ name: 1 }, { unique: true });
    await this.deployments.createIndex({ clusterId: 1 });
    await this.deployments.createIndex({ name: 1 }, { unique: true });
    await this.users.createIndex({ email: 1 }, { unique: true });
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  async getClusters(): Promise<ClusterMetadata[]> {
    return (await this.clusters.find({}).toArray()).map(doc => fromDoc<ClusterMetadata>(doc));
  }

  async saveCluster(cluster: ClusterMetadata): Promise<void> {
    const doc = toDoc(cluster);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.clusters.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async saveClusterList(clusters: ClusterMetadata[]): Promise<void> {
    await this.clusters.deleteMany({});
    if (clusters.length > 0) {
      await this.clusters.insertMany(clusters.map(toDoc));
    }
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
    if (cluster.gpuEnabled !== undefined) c.gpuEnabled = cluster.gpuEnabled;
    await this.saveCluster(c);
    return c;
  }

  async updateClusterProgress(clusterId: string, progress: ClusterProgress): Promise<void> {
    await this.clusters.updateOne(
      { _id: clusterId as any },
      { $set: { progress } }
    );
  }

  async getDeployments(): Promise<DeploymentMetadata[]> {
    return (await this.deployments.find({}).toArray()).map(doc => fromDoc<DeploymentMetadata>(doc));
  }

  async saveDeployment(deployment: DeploymentMetadata): Promise<void> {
    const doc = toDoc(deployment);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.deployments.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async saveDeploymentList(deployments: DeploymentMetadata[]): Promise<void> {
    await this.deployments.deleteMany({});
    if (deployments.length > 0) {
      await this.deployments.insertMany(deployments.map(toDoc));
    }
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
    return (await this.users.find({}).toArray()).map(doc => fromDoc<UserMetadata>(doc));
  }

  async saveUser(user: UserMetadata): Promise<void> {
    const doc = toDoc(user);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.users.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async saveUserList(users: UserMetadata[]): Promise<void> {
    await this.users.deleteMany({});
    if (users.length > 0) {
      await this.users.insertMany(users.map(toDoc));
    }
  }

  async getUserByEmail(email: string): Promise<UserMetadata | undefined> {
    const doc = await this.users.findOne({ email: email.trim().toLowerCase() });
    return doc ? fromDoc<UserMetadata>(doc) : undefined;
  }

  async getUserById(id: string): Promise<UserMetadata | undefined> {
    const doc = await this.users.findOne({ _id: id as any });
    return doc ? fromDoc<UserMetadata>(doc) : undefined;
  }
}