import type { AccessRequest, EgressGrantRecord, EgressRequest } from '@koala/harness-types';
import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { BindingTypeRecord } from './lib/service-binding.js';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, PartialInfo, PendingApprovalMetadata } from '../platform/lib/types.js';
import type { ClusterProviderSpec } from './lib/cluster-providers.js';
import type { Collection, Db } from 'mongodb';
import type { StoredAppSpec } from './lib/app-spec.js';
import type { WorkFailure } from './lib/work-failures.js';
import { mergeRecord } from '../platform/lib/merge-record.js';
import { v4 as uuidv4 } from 'uuid';
import type { SecretKey } from '../platform/lib/crypto.js';
import { hasPlainSecret, sealDeployment, unsealDeployment } from './lib/deployment-secrets.js';

export interface InfrastructureStore extends AreaStore {
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
  sealDeploymentSecrets(): Promise<number>;
  getAppSpecs(): Promise<StoredAppSpec[]>;
  saveAppSpec(spec: StoredAppSpec): Promise<void>;
  deleteAppSpec(id: string): Promise<void>;
  getClusterProviders(): Promise<ClusterProviderSpec[]>;
  saveClusterProvider(provider: ClusterProviderSpec): Promise<void>;
  getPendingApprovals(): Promise<PendingApprovalMetadata[]>;
  savePendingApproval(approval: PendingApprovalMetadata): Promise<void>;
  deletePendingApproval(id: string): Promise<void>;
  getWorkFailures(ownerId?: string): Promise<WorkFailure[]>;
  addWorkFailure(failure: WorkFailure): Promise<void>;
  clearWorkFailures(ownerId: string, ids: readonly string[] | 'all', at: string): Promise<number>;
  pruneWorkFailures(before: string): Promise<void>;
  getEgressGrants(ownerId?: string): Promise<EgressGrantRecord[]>;
  saveEgressGrant(grant: EgressGrantRecord): Promise<void>;
  getEgressRequests(ownerId: string, filter?: { conversationId?: string | undefined; treeId?: string | undefined }): Promise<EgressRequest[]>;
  getEgressRequest(ownerId: string, id: string): Promise<EgressRequest | undefined>;
  saveEgressRequest(request: EgressRequest): Promise<void>;
  getAccessRequests(ownerId: string, conversationId?: string): Promise<AccessRequest[]>;
  getAccessRequest(ownerId: string, id: string): Promise<AccessRequest | undefined>;
  saveAccessRequest(request: AccessRequest): Promise<void>;
  getBindingTypes(): Promise<BindingTypeRecord[]>;
  saveBindingType(record: BindingTypeRecord): Promise<void>;
  deleteBindingType(id: string): Promise<void>;
}

export class MongoInfrastructureStore implements InfrastructureStore {
  constructor(private readonly db: () => Db, private readonly dataKey: SecretKey) {}

  private get accessRequests(): Collection {
    return this.db().collection('accessRequests');
  }

  private get appSpecs(): Collection {
    return this.db().collection('appSpecs');
  }

  private get bindingTypes(): Collection {
    return this.db().collection('bindingTypes');
  }

  private get clusterProviders(): Collection {
    return this.db().collection('clusterProviders');
  }

  private get clusters(): Collection {
    return this.db().collection('clusters');
  }

  private get deployments(): Collection {
    return this.db().collection('deployments');
  }

  private get egressGrants(): Collection {
    return this.db().collection('egressGrants');
  }

  private get egressRequests(): Collection {
    return this.db().collection('egressRequests');
  }

  private get pendingApprovals(): Collection {
    return this.db().collection('pendingApprovals');
  }

  async ensureIndexes(): Promise<void> {
    await this.clusters.createIndex({ name: 1 }, { unique: true });
    await this.deployments.createIndex({ clusterId: 1 });
    await this.deployments.dropIndex('name_1').catch(() => undefined);
    await this.deployments.createIndex({ ownerId: 1, name: 1 }, { unique: true });
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

  async saveClusterInfo(cluster: PartialInfo<ClusterMetadata>): Promise<ClusterMetadata> {
    const id = cluster.id || uuidv4();
    const previous = (await this.getClusters()).find((x: ClusterMetadata) => x.id === id);
    const merged = mergeRecord(previous, cluster as Partial<ClusterMetadata>);
    const c: ClusterMetadata = {
      ...merged,

      id: id,
      name: merged.name || '',
      provider: merged.provider || 'k3d',
      status: merged.status || 'provisioning',
    };
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
    return (await this.deployments.find({}).toArray()).map(doc => unsealDeployment(fromDoc<DeploymentMetadata>(doc), this.dataKey));
  }

  async saveDeployment(deployment: DeploymentMetadata): Promise<void> {
    const doc = toDoc(sealDeployment(deployment, this.dataKey));
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.deployments.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async saveDeploymentList(deployments: DeploymentMetadata[]): Promise<void> {
    const keep = deployments.map((deployment) => toDoc(sealDeployment(deployment, this.dataKey)));
    const keepIds = keep.map((d) => d._id);

    const ops: any[] = keep.map((doc) => {
      const { _id, ...rest } = doc;
      return { replaceOne: { filter: { _id }, replacement: rest, upsert: true } };
    });
    ops.push({ deleteMany: { filter: keepIds.length ? { _id: { $nin: keepIds } } : {} } });

    await this.deployments.bulkWrite(ops, { ordered: false });
  }

  async sealDeploymentSecrets(): Promise<number> {
    const plain = (await this.deployments.find({}).toArray()).filter((doc) => hasPlainSecret(doc));
    for (const doc of plain) await this.saveDeployment(fromDoc<DeploymentMetadata>(doc));
    return plain.length;
  }

  async deleteDeployment(id: string): Promise<void> {
    await this.deployments.deleteOne({ _id: id as any });
  }

  async saveDeploymentInfo(deployment: PartialInfo<DeploymentMetadata>): Promise<DeploymentMetadata> {
    const id = deployment.id || uuidv4();
    const previous = (await this.getDeployments()).find((x: DeploymentMetadata) => x.id === id);
    const merged = mergeRecord(previous, deployment as Partial<DeploymentMetadata>);
    const d: DeploymentMetadata = {
      ...merged,

      id: id,
      name: merged.name || '',
      clusterId: merged.clusterId || '',
      strategy: merged.strategy || 'helm',
      status: merged.status || 'deploying',
    };
    await this.saveDeployment(d);
    return d;
  }

  async getAppSpecs(): Promise<StoredAppSpec[]> {
    return (await this.appSpecs.find({}).toArray()).map((doc) => fromDoc<StoredAppSpec>(doc));
  }

  async saveAppSpec(spec: StoredAppSpec): Promise<void> {
    const doc = toDoc(spec);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.appSpecs.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async getClusterProviders(): Promise<ClusterProviderSpec[]> {
    const docs = (await this.clusterProviders.find({}).toArray()) as Array<Record<string, any>>;
    return docs.map(({ _id, ...rest }) => rest as ClusterProviderSpec);
  }

  async saveClusterProvider(provider: ClusterProviderSpec): Promise<void> {
    const { value } = provider;
    await this.clusterProviders.replaceOne({ _id: value as any }, { _id: value, ...provider }, { upsert: true });
  }

  async deleteAppSpec(id: string): Promise<void> {
    await this.appSpecs.deleteOne({ _id: id as any });
  }

  async getPendingApprovals(): Promise<PendingApprovalMetadata[]> {
    return (await this.pendingApprovals.find({}).toArray()).map(doc => fromDoc<PendingApprovalMetadata>(doc));
  }

  async savePendingApproval(approval: PendingApprovalMetadata): Promise<void> {
    const doc = toDoc(approval);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.pendingApprovals.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async deletePendingApproval(id: string): Promise<void> {
    await this.pendingApprovals.deleteOne({ _id: id as any });
  }

  async getWorkFailures(ownerId?: string): Promise<WorkFailure[]> {
    const docs = await this.db().collection('workFailures').find(ownerId === undefined ? {} : { ownerId }).sort({ failedAt: -1 }).toArray();
    return docs.map((doc) => fromDoc<WorkFailure>(doc as Record<string, unknown>));
  }

  async addWorkFailure(failure: WorkFailure): Promise<void> {
    const { _id, ...doc } = toDoc(failure) as Record<string, unknown>;
    await this.db().collection('workFailures').updateOne({ _id: _id as never }, { $setOnInsert: doc }, { upsert: true });
  }

  async clearWorkFailures(ownerId: string, ids: readonly string[] | 'all', at: string): Promise<number> {
    const result = await this.db().collection('workFailures').updateMany(
      { ownerId, clearedAt: { $exists: false }, ...(ids === 'all' ? {} : { _id: { $in: [...ids] as never[] } }) },
      { $set: { clearedAt: at } },
    );
    return result.modifiedCount;
  }

  async pruneWorkFailures(before: string): Promise<void> {
    await this.db().collection('workFailures').deleteMany({ failedAt: { $lt: before } });
  }

  async getEgressGrants(ownerId?: string): Promise<EgressGrantRecord[]> {
    const docs = await this.egressGrants.find(ownerId === undefined ? {} : { ownerId }).toArray();
    return docs.map((d: Record<string, unknown>) => fromDoc<EgressGrantRecord>(d));
  }

  async saveEgressGrant(grant: EgressGrantRecord): Promise<void> {
    const doc = toDoc(grant);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.egressGrants.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async getEgressRequests(ownerId: string, filter: { conversationId?: string | undefined; treeId?: string | undefined } = {}): Promise<EgressRequest[]> {
    const query: Record<string, unknown> = { ownerId };
    if (filter.conversationId !== undefined) query.conversationId = filter.conversationId;
    if (filter.treeId !== undefined) query.treeId = filter.treeId;
    const docs = await this.egressRequests.find(query).sort({ createdAt: 1 }).toArray();
    return docs.map((d: Record<string, unknown>) => fromDoc<EgressRequest>(d));
  }

  async getEgressRequest(ownerId: string, id: string): Promise<EgressRequest | undefined> {
    const doc = await this.egressRequests.findOne({ _id: id as any, ownerId });
    return doc ? fromDoc<EgressRequest>(doc as Record<string, unknown>) : undefined;
  }

  async saveEgressRequest(request: EgressRequest): Promise<void> {
    const doc = toDoc(request);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.egressRequests.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async getAccessRequests(ownerId: string, conversationId?: string): Promise<AccessRequest[]> {
    const query = conversationId === undefined ? { ownerId } : { ownerId, conversationId };
    const docs = await this.accessRequests.find(query).sort({ createdAt: 1 }).toArray();
    return docs.map((d: Record<string, unknown>) => fromDoc<AccessRequest>(d));
  }

  async getAccessRequest(ownerId: string, id: string): Promise<AccessRequest | undefined> {
    const doc = await this.accessRequests.findOne({ _id: id as any, ownerId });
    return doc ? fromDoc<AccessRequest>(doc as Record<string, unknown>) : undefined;
  }

  async saveAccessRequest(request: AccessRequest): Promise<void> {
    const doc = toDoc(request);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.accessRequests.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async getBindingTypes(): Promise<BindingTypeRecord[]> {
    return (await this.bindingTypes.find({}).toArray()).map((doc) => fromDoc<BindingTypeRecord>(doc));
  }

  async saveBindingType(record: BindingTypeRecord): Promise<void> {
    const doc = toDoc(record);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.bindingTypes.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async deleteBindingType(id: string): Promise<void> {
    await this.bindingTypes.deleteOne({ _id: id as any });
  }
}
