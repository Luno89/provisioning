import type { AccessRequest, EgressGrantRecord, EgressRequest } from '@koala/harness-types';
import { ignore } from '@koala/engine-core/failures';
import { type AreaStore, fromDoc, type Identified } from '../platform/lib/collection.js';
import type { BindingTypeRecord } from './lib/service-binding.js';
import type {
  ClusterMetadata, ClusterProgress, DeploymentMetadata, PartialInfo, PendingApprovalMetadata, SecretKey,
} from '../platform/index.js';
import type { ClusterProviderSpec } from './lib/cluster-providers.js';
import type { Collection, Db, Document } from 'mongodb';
import type { StoredAppSpec } from './lib/app-spec.js';
import type { WorkFailure } from './lib/work-failures.js';
import { SERVER_ORDER_LOG_LINES, type ServerOrder } from './lib/server-orders.js';
import { mergeRecord } from '../platform/lib/merge-record.js';
import { v4 as uuidv4 } from 'uuid';
import { hasPlainSecret, sealDeployment, unsealDeployment } from './lib/deployment-secrets.js';

export interface InfrastructureStore extends AreaStore {
  getClusters(): Promise<ClusterMetadata[]>;
  saveCluster(cluster: ClusterMetadata): Promise<void>;
  deleteCluster(id: string): Promise<void>;
  patchCluster(id: string, patch: Partial<ClusterMetadata>): Promise<void>;
  saveClusterInfo(cluster: PartialInfo<ClusterMetadata>): Promise<ClusterMetadata>;
  updateClusterProgress(clusterId: string, progress: ClusterProgress): Promise<void>;
  getDeployments(): Promise<DeploymentMetadata[]>;
  saveDeployment(deployment: DeploymentMetadata): Promise<void>;
  deleteDeploymentsOfCluster(clusterId: string): Promise<number>;
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
  getServerOrders(ownerId: string): Promise<ServerOrder[]>;
  getServerOrder(id: string): Promise<ServerOrder | undefined>;
  saveServerOrder(order: ServerOrder): Promise<void>;
  patchServerOrder(id: string, patch: Partial<Omit<ServerOrder, 'id' | 'ownerId'>>): Promise<ServerOrder | undefined>;
  appendServerOrderLog(id: string, lines: readonly string[]): Promise<void>;
}

type Stored = { _id: string } & Document;

function fieldsOf<T extends Identified>(entity: T): Document {
  const { id: _id, ...fields } = entity;
  return fields;
}

export class MongoInfrastructureStore implements InfrastructureStore {
  constructor(private readonly db: () => Db, private readonly dataKey: SecretKey) {}

  private get accessRequests(): Collection<Stored> {
    return this.db().collection<Stored>('accessRequests');
  }

  private get appSpecs(): Collection<Stored> {
    return this.db().collection<Stored>('appSpecs');
  }

  private get bindingTypes(): Collection<Stored> {
    return this.db().collection<Stored>('bindingTypes');
  }

  private get clusterProviders(): Collection<Stored> {
    return this.db().collection<Stored>('clusterProviders');
  }

  private get clusters(): Collection<Stored> {
    return this.db().collection<Stored>('clusters');
  }

  private get deployments(): Collection<Stored> {
    return this.db().collection<Stored>('deployments');
  }

  private get egressGrants(): Collection<Stored> {
    return this.db().collection<Stored>('egressGrants');
  }

  private get egressRequests(): Collection<Stored> {
    return this.db().collection<Stored>('egressRequests');
  }

  private get pendingApprovals(): Collection<Stored> {
    return this.db().collection<Stored>('pendingApprovals');
  }

  private get serverOrders(): Collection<Stored> {
    return this.db().collection<Stored>('serverOrders');
  }

  private get serverOrderLogs(): Collection<{ _id: string; log?: string[] }> {
    return this.db().collection<{ _id: string; log?: string[] }>('serverOrders');
  }

  private get workFailures(): Collection<Stored> {
    return this.db().collection<Stored>('workFailures');
  }

  async ensureIndexes(): Promise<void> {
    await this.clusters.createIndex({ name: 1 }, { unique: true });
    await this.deployments.createIndex({ clusterId: 1 });
    await this.deployments.dropIndex('name_1').catch(ignore('the old name-only index is gone once it has been dropped, and an install made after it never had one'));
    await this.deployments.createIndex({ ownerId: 1, name: 1 }, { unique: true });
  }

  async getClusters(): Promise<ClusterMetadata[]> {
    return (await this.clusters.find({}).toArray()).map(doc => fromDoc<ClusterMetadata>(doc));
  }

  async saveCluster(cluster: ClusterMetadata): Promise<void> {
    await this.clusters.replaceOne({ _id: cluster.id }, fieldsOf(cluster), { upsert: true });
  }

  async deleteCluster(id: string): Promise<void> {
    await this.clusters.deleteOne({ _id: id });
  }

  async patchCluster(id: string, patch: Partial<ClusterMetadata>): Promise<void> {
    const { id: _id, ...fields } = patch;
    if (Object.keys(fields).length > 0) await this.clusters.updateOne({ _id: id }, { $set: fields });
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
      { _id: clusterId },
      { $set: { progress } }
    );
  }

  async getDeployments(): Promise<DeploymentMetadata[]> {
    return (await this.deployments.find({}).toArray()).map(doc => unsealDeployment(fromDoc<DeploymentMetadata>(doc), this.dataKey));
  }

  async saveDeployment(deployment: DeploymentMetadata): Promise<void> {
    await this.deployments.replaceOne({ _id: deployment.id }, fieldsOf(sealDeployment(deployment, this.dataKey)), { upsert: true });
  }

  async deleteDeploymentsOfCluster(clusterId: string): Promise<number> {
    return (await this.deployments.deleteMany({ clusterId })).deletedCount;
  }

  async sealDeploymentSecrets(): Promise<number> {
    const plain = (await this.deployments.find({}).toArray()).filter((doc) => hasPlainSecret(doc));
    for (const doc of plain) await this.saveDeployment(fromDoc<DeploymentMetadata>(doc));
    return plain.length;
  }

  async deleteDeployment(id: string): Promise<void> {
    await this.deployments.deleteOne({ _id: id });
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
    await this.appSpecs.replaceOne({ _id: spec.id }, fieldsOf(spec), { upsert: true });
  }

  async getClusterProviders(): Promise<ClusterProviderSpec[]> {
    const docs = await this.clusterProviders.find({}).toArray();
    return docs.map(({ _id, ...rest }) => rest as ClusterProviderSpec);
  }

  async saveClusterProvider(provider: ClusterProviderSpec): Promise<void> {
    const { value } = provider;
    await this.clusterProviders.replaceOne({ _id: value }, { ...provider }, { upsert: true });
  }

  async deleteAppSpec(id: string): Promise<void> {
    await this.appSpecs.deleteOne({ _id: id });
  }

  async getPendingApprovals(): Promise<PendingApprovalMetadata[]> {
    return (await this.pendingApprovals.find({}).toArray()).map(doc => fromDoc<PendingApprovalMetadata>(doc));
  }

  async savePendingApproval(approval: PendingApprovalMetadata): Promise<void> {
    await this.pendingApprovals.replaceOne({ _id: approval.id }, fieldsOf(approval), { upsert: true });
  }

  async deletePendingApproval(id: string): Promise<void> {
    await this.pendingApprovals.deleteOne({ _id: id });
  }

  async getWorkFailures(ownerId?: string): Promise<WorkFailure[]> {
    const docs = await this.workFailures.find(ownerId === undefined ? {} : { ownerId }).sort({ failedAt: -1 }).toArray();
    return docs.map((doc) => fromDoc<WorkFailure>(doc));
  }

  async addWorkFailure(failure: WorkFailure): Promise<void> {
    await this.workFailures.updateOne({ _id: failure.id }, { $setOnInsert: fieldsOf(failure) }, { upsert: true });
  }

  async clearWorkFailures(ownerId: string, ids: readonly string[] | 'all', at: string): Promise<number> {
    const result = await this.workFailures.updateMany(
      { ownerId, clearedAt: { $exists: false }, ...(ids === 'all' ? {} : { _id: { $in: [...ids] } }) },
      { $set: { clearedAt: at } },
    );
    return result.modifiedCount;
  }

  async pruneWorkFailures(before: string): Promise<void> {
    await this.workFailures.deleteMany({ failedAt: { $lt: before } });
  }

  async getEgressGrants(ownerId?: string): Promise<EgressGrantRecord[]> {
    const docs = await this.egressGrants.find(ownerId === undefined ? {} : { ownerId }).toArray();
    return docs.map((d) => fromDoc<EgressGrantRecord>(d));
  }

  async saveEgressGrant(grant: EgressGrantRecord): Promise<void> {
    await this.egressGrants.replaceOne({ _id: grant.id }, fieldsOf(grant), { upsert: true });
  }

  async getEgressRequests(ownerId: string, filter: { conversationId?: string | undefined; treeId?: string | undefined } = {}): Promise<EgressRequest[]> {
    const query: Record<string, unknown> = { ownerId };
    if (filter.conversationId !== undefined) query.conversationId = filter.conversationId;
    if (filter.treeId !== undefined) query.treeId = filter.treeId;
    const docs = await this.egressRequests.find(query).sort({ createdAt: 1 }).toArray();
    return docs.map((d) => fromDoc<EgressRequest>(d));
  }

  async getServerOrders(ownerId: string): Promise<ServerOrder[]> {
    const docs = await this.serverOrders.find({ ownerId }, { projection: { log: 0 } }).sort({ createdAt: -1 }).toArray();
    return docs.map((doc) => fromDoc<ServerOrder>(doc));
  }

  async getServerOrder(id: string): Promise<ServerOrder | undefined> {
    const doc = await this.serverOrders.findOne({ _id: id });
    return doc ? fromDoc<ServerOrder>(doc) : undefined;
  }

  async saveServerOrder(order: ServerOrder): Promise<void> {
    await this.serverOrders.replaceOne({ _id: order.id }, fieldsOf(order), { upsert: true });
  }

  async patchServerOrder(id: string, patch: Partial<Omit<ServerOrder, 'id' | 'ownerId'>>): Promise<ServerOrder | undefined> {
    const doc = await this.serverOrders.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date().toISOString() } }, { returnDocument: 'after' });
    return doc ? fromDoc<ServerOrder>(doc) : undefined;
  }

  async appendServerOrderLog(id: string, lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return;
    await this.serverOrderLogs.updateOne({ _id: id }, { $push: { log: { $each: [...lines], $slice: -SERVER_ORDER_LOG_LINES } } });
  }

  async getEgressRequest(ownerId: string, id: string): Promise<EgressRequest | undefined> {
    const doc = await this.egressRequests.findOne({ _id: id, ownerId });
    return doc ? fromDoc<EgressRequest>(doc) : undefined;
  }

  async saveEgressRequest(request: EgressRequest): Promise<void> {
    await this.egressRequests.replaceOne({ _id: request.id }, fieldsOf(request), { upsert: true });
  }

  async getAccessRequests(ownerId: string, conversationId?: string): Promise<AccessRequest[]> {
    const query = conversationId === undefined ? { ownerId } : { ownerId, conversationId };
    const docs = await this.accessRequests.find(query).sort({ createdAt: 1 }).toArray();
    return docs.map((d) => fromDoc<AccessRequest>(d));
  }

  async getAccessRequest(ownerId: string, id: string): Promise<AccessRequest | undefined> {
    const doc = await this.accessRequests.findOne({ _id: id, ownerId });
    return doc ? fromDoc<AccessRequest>(doc) : undefined;
  }

  async saveAccessRequest(request: AccessRequest): Promise<void> {
    await this.accessRequests.replaceOne({ _id: request.id }, fieldsOf(request), { upsert: true });
  }

  async getBindingTypes(): Promise<BindingTypeRecord[]> {
    return (await this.bindingTypes.find({}).toArray()).map((doc) => fromDoc<BindingTypeRecord>(doc));
  }

  async saveBindingType(record: BindingTypeRecord): Promise<void> {
    await this.bindingTypes.replaceOne({ _id: record.id }, fieldsOf(record), { upsert: true });
  }

  async deleteBindingType(id: string): Promise<void> {
    await this.bindingTypes.deleteOne({ _id: id });
  }
}
