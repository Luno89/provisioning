import { asStored } from '../../platform/testing/as-stored.js';
import { randomUUID } from 'node:crypto';
import type { AccessRequest, EgressGrantRecord, EgressRequest } from '@koala/harness-types';
import { loadKey } from '../../platform/lib/keys.js';
import { mergeRecord } from '../../platform/lib/merge-record.js';
import type {
  ClusterMetadata, DeploymentMetadata, PartialInfo, PendingApprovalMetadata, SecretKey,
} from '../../platform/index.js';
import { collectionIn, copied, MemoryRecords, type Collections } from '../../platform/testing/memory-records.js';
import type { StoredAppSpec } from '../lib/app-spec.js';
import { hasPlainSecret, sealDeployment, unsealDeployment } from '../lib/deployment-secrets.js';
import type { BindingTypeRecord } from '../lib/service-binding.js';
import { SERVER_ORDER_LOG_LINES, type ServerOrder } from '../lib/server-orders.js';
import type { WorkFailure } from '../lib/work-failures.js';
import type { DeploymentHealth, InfrastructureStore, ProvisioningOpened, ProvisioningPatch } from '../store.js';
import { withPatch, type ProvisioningRecord } from '../lib/provisioning.js';
import type { Watching } from '../../platform/lib/change-streams.js';
import { FOLLOWED_DEPLOYMENT_STATUSES, namesWorkflow, type FollowedRecord } from '../lib/followed-work.js';

const TEST_KEY = loadKey({ DATA_KEY: 'k'.repeat(64) }, 'data');

const stored = <T extends object>(record: T): T => asStored(copied(record));

const earlier = (a: unknown, b: unknown): number => {
  const missingA = a === undefined || a === null;
  const missingB = b === undefined || b === null;
  if (missingA || missingB) return Number(!missingA) - Number(!missingB);
  return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
};

const duplicate = (collection: string, key: string): Error =>
  Object.assign(new Error(`E11000 duplicate key error collection: ${collection} dup key: ${key}`), { code: 11000 });

export class MemoryInfrastructureStore implements InfrastructureStore {
  private readonly clusters: MemoryRecords<ClusterMetadata>;
  private readonly deployments: MemoryRecords<DeploymentMetadata>;
  private readonly appSpecs: MemoryRecords<StoredAppSpec>;
  private readonly pendingApprovals: MemoryRecords<PendingApprovalMetadata>;
  private readonly workFailures: MemoryRecords<WorkFailure>;
  private readonly egressGrants: MemoryRecords<EgressGrantRecord>;
  private readonly egressRequests: MemoryRecords<EgressRequest>;
  private readonly accessRequests: MemoryRecords<AccessRequest>;
  private readonly bindingTypes: MemoryRecords<BindingTypeRecord>;
  private readonly serverOrders: MemoryRecords<ServerOrder>;
  private readonly provisioning: MemoryRecords<ProvisioningRecord>;

  constructor(private readonly dataKey: SecretKey = TEST_KEY, collections: Collections = new Map()) {
    this.clusters = new MemoryRecords(collectionIn<ClusterMetadata>(collections, 'clusters'));
    this.deployments = new MemoryRecords(collectionIn<DeploymentMetadata>(collections, 'deployments'));
    this.appSpecs = new MemoryRecords(collectionIn<StoredAppSpec>(collections, 'appSpecs'));
    this.pendingApprovals = new MemoryRecords(collectionIn<PendingApprovalMetadata>(collections, 'pendingApprovals'));
    this.workFailures = new MemoryRecords(collectionIn<WorkFailure>(collections, 'workFailures'));
    this.egressGrants = new MemoryRecords(collectionIn<EgressGrantRecord>(collections, 'egressGrants'));
    this.egressRequests = new MemoryRecords(collectionIn<EgressRequest>(collections, 'egressRequests'));
    this.accessRequests = new MemoryRecords(collectionIn<AccessRequest>(collections, 'accessRequests'));
    this.bindingTypes = new MemoryRecords(collectionIn<BindingTypeRecord>(collections, 'bindingTypes'));
    this.serverOrders = new MemoryRecords(collectionIn<ServerOrder>(collections, 'serverOrders'));
    this.provisioning = new MemoryRecords(collectionIn<ProvisioningRecord>(collections, 'provisioning'));
  }

  async ensureIndexes(): Promise<void> {}

  watchFollowed(on: (followed: FollowedRecord) => void): Watching {
    const stops = [
      this.deployments.watch((stored) => {
        const record = unsealDeployment(stored, this.dataKey);
        if (namesWorkflow(record, FOLLOWED_DEPLOYMENT_STATUSES)) on({ kind: 'deployment', record });
      }),
    ];
    return { ready: Promise.resolve(), close: async () => { for (const stop of stops) stop(); } };
  }

  async getClusters(): Promise<ClusterMetadata[]> {
    return this.clusters.all();
  }

  async saveCluster(cluster: ClusterMetadata): Promise<void> {
    const name = asStored(cluster.name);
    if (this.clusters.all().some((other) => other.id !== cluster.id && asStored(other.name) === name)) throw duplicate('clusters', `{ name: ${JSON.stringify(name)} }`);
    this.clusters.put(stored(cluster));
  }

  async deleteCluster(id: string): Promise<void> {
    this.clusters.delete(id);
  }

  async patchCluster(id: string, patch: Partial<ClusterMetadata>): Promise<void> {
    const { id: _id, ...fields } = patch;
    if (Object.keys(fields).length === 0) return;
    this.clusters.change(id, (cluster) => ({ ...cluster, ...fields }));
  }

  async getDeployments(): Promise<DeploymentMetadata[]> {
    return this.deployments.all().map((deployment) => unsealDeployment(deployment, this.dataKey));
  }

  async saveDeployment(deployment: DeploymentMetadata): Promise<void> {
    const sealed = stored(sealDeployment(deployment, this.dataKey));
    const clash = this.deployments.all().some((other) => other.id !== deployment.id
      && asStored(other.ownerId) === asStored(sealed.ownerId) && asStored(other.name) === asStored(sealed.name));
    if (clash) throw duplicate('deployments', `{ ownerId: ${JSON.stringify(asStored(sealed.ownerId))}, name: ${JSON.stringify(asStored(sealed.name))} }`);
    this.deployments.put(sealed);
  }

  async patchDeploymentHealth(id: string, health: DeploymentHealth): Promise<void> {
    if (Object.keys(health).length === 0) return;
    this.deployments.change(id, (deployment) => {
      const next: Record<string, unknown> = { ...deployment, ...health };
      for (const [field, value] of Object.entries(health)) if (value === undefined) delete next[field];
      return next as unknown as DeploymentMetadata;
    });
  }

  async deleteDeploymentsOfCluster(clusterId: string): Promise<number> {
    let removed = 0;
    for (const deployment of this.deployments.all()) {
      if (deployment.clusterId === clusterId && this.deployments.delete(deployment.id)) removed += 1;
    }
    return removed;
  }

  async deleteDeployment(id: string): Promise<void> {
    this.deployments.delete(id);
  }

  async saveDeploymentInfo(deployment: PartialInfo<DeploymentMetadata>): Promise<DeploymentMetadata> {
    const id = deployment.id || randomUUID();
    const previous = (await this.getDeployments()).find((x) => x.id === id);
    const merged = mergeRecord(previous, deployment as Partial<DeploymentMetadata>);
    const next: DeploymentMetadata = {
      ...merged,
      id,
      name: merged.name || '',
      clusterId: merged.clusterId || '',
      strategy: merged.strategy || 'helm',
      status: merged.status || 'deploying',
    };
    await this.saveDeployment(next);
    return next;
  }

  async dropClusterProviders(): Promise<number> {
    return 0;
  }

  async pinVllmLatest(version: string): Promise<number> {
    const latest = this.deployments.all().filter((deployment) => deployment.appType === 'vllm' && deployment.webTag === 'latest');
    for (const deployment of latest) await this.saveDeployment({ ...deployment, webTag: version });
    return latest.length;
  }

  async sealDeploymentSecrets(): Promise<number> {
    const plain = this.deployments.all().filter((deployment) => hasPlainSecret(deployment));
    for (const deployment of plain) await this.saveDeployment(deployment);
    return plain.length;
  }

  async getAppSpecs(): Promise<StoredAppSpec[]> {
    return this.appSpecs.all();
  }

  async saveAppSpec(spec: StoredAppSpec): Promise<void> {
    this.appSpecs.put(stored(spec));
  }

  async deleteAppSpec(id: string): Promise<void> {
    this.appSpecs.delete(id);
  }

  async getPendingApprovals(): Promise<PendingApprovalMetadata[]> {
    return this.pendingApprovals.all();
  }

  async savePendingApproval(approval: PendingApprovalMetadata): Promise<void> {
    this.pendingApprovals.put(stored(approval));
  }

  async deletePendingApproval(id: string): Promise<void> {
    this.pendingApprovals.delete(id);
  }

  async getWorkFailures(ownerId?: string): Promise<WorkFailure[]> {
    return this.workFailures.all()
      .filter((failure) => ownerId === undefined || failure.ownerId === ownerId)
      .sort((a, b) => earlier(b.failedAt, a.failedAt));
  }

  async addWorkFailure(failure: WorkFailure): Promise<void> {
    if (this.workFailures.get(failure.id)) return;
    this.workFailures.put(stored(failure));
  }

  async clearWorkFailures(ownerId: string, ids: readonly string[] | 'all', at: string): Promise<number> {
    let cleared = 0;
    for (const failure of this.workFailures.all()) {
      if (failure.ownerId !== ownerId || 'clearedAt' in failure) continue;
      if (ids !== 'all' && !ids.includes(failure.id)) continue;
      this.workFailures.change(failure.id, (row) => ({ ...row, clearedAt: at }));
      cleared += 1;
    }
    return cleared;
  }

  async pruneWorkFailures(before: string): Promise<void> {
    for (const failure of this.workFailures.all()) {
      if (typeof failure.failedAt === 'string' && failure.failedAt < before) this.workFailures.delete(failure.id);
    }
  }

  async getEgressGrants(ownerId?: string): Promise<EgressGrantRecord[]> {
    return this.egressGrants.all().filter((grant) => ownerId === undefined || grant.ownerId === ownerId);
  }

  async saveEgressGrant(grant: EgressGrantRecord): Promise<void> {
    this.egressGrants.put(stored(grant));
  }

  async getEgressRequests(ownerId: string, filter: { conversationId?: string | undefined; treeId?: string | undefined } = {}): Promise<EgressRequest[]> {
    return this.egressRequests.all()
      .filter((request) => request.ownerId === ownerId
        && (filter.conversationId === undefined || request.conversationId === filter.conversationId)
        && (filter.treeId === undefined || request.treeId === filter.treeId))
      .sort((a, b) => earlier(a.createdAt, b.createdAt));
  }

  async getEgressRequest(ownerId: string, id: string): Promise<EgressRequest | undefined> {
    const request = this.egressRequests.get(id);
    return request && request.ownerId === ownerId ? request : undefined;
  }

  async saveEgressRequest(request: EgressRequest): Promise<void> {
    this.egressRequests.put(stored(request));
  }

  async getAccessRequests(ownerId: string, conversationId?: string): Promise<AccessRequest[]> {
    return this.accessRequests.all()
      .filter((request) => request.ownerId === ownerId && (conversationId === undefined || request.conversationId === conversationId))
      .sort((a, b) => earlier(a.createdAt, b.createdAt));
  }

  async getAccessRequest(ownerId: string, id: string): Promise<AccessRequest | undefined> {
    const request = this.accessRequests.get(id);
    return request && request.ownerId === ownerId ? request : undefined;
  }

  async saveAccessRequest(request: AccessRequest): Promise<void> {
    this.accessRequests.put(stored(request));
  }

  async getBindingTypes(): Promise<BindingTypeRecord[]> {
    return this.bindingTypes.all();
  }

  async saveBindingType(record: BindingTypeRecord): Promise<void> {
    this.bindingTypes.put(stored(record));
  }

  async deleteBindingType(id: string): Promise<void> {
    this.bindingTypes.delete(id);
  }

  async getServerOrders(ownerId: string): Promise<ServerOrder[]> {
    return this.serverOrders.all()
      .filter((order) => order.ownerId === ownerId)
      .sort((a, b) => earlier(b.createdAt, a.createdAt))
      .map(({ log: _log, ...order }) => order);
  }

  async getServerOrder(id: string): Promise<ServerOrder | undefined> {
    return this.serverOrders.get(id);
  }

  async saveServerOrder(order: ServerOrder): Promise<void> {
    this.serverOrders.put(stored(order));
  }

  async patchServerOrder(id: string, patch: Partial<Omit<ServerOrder, 'id' | 'ownerId'>>): Promise<ServerOrder | undefined> {
    this.serverOrders.change(id, (order) => ({ ...order, ...patch, updatedAt: new Date().toISOString() }));
    return this.serverOrders.get(id);
  }

  async appendServerOrderLog(id: string, lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return;
    this.serverOrders.change(id, (order) => ({ ...order, log: [...(order.log ?? []), ...lines].slice(-SERVER_ORDER_LOG_LINES) }));
  }

  async getProvisioning(clusterId?: string): Promise<ProvisioningRecord[]> {
    return this.provisioning.all()
      .filter((record) => clusterId === undefined || record.target.clusterId === clusterId)
      .sort((a, b) => earlier(a.startedAt, b.startedAt) || earlier(a.id, b.id));
  }

  async getProvisioningRun(id: string): Promise<ProvisioningRecord | undefined> {
    return this.provisioning.get(id);
  }

  async openProvisioning(record: ProvisioningRecord): Promise<ProvisioningOpened> {
    const running = this.provisioning.all().find((other) => other.state === 'running' && other.target.clusterId === record.target.clusterId);
    if (running) return { opened: false, running };
    if (this.provisioning.get(record.id)) throw duplicate('provisioning', `{ _id: ${JSON.stringify(record.id)} }`);
    this.provisioning.put(stored(record));
    return { opened: true };
  }

  async patchProvisioning(id: string, patch: ProvisioningPatch, whileRunning = false): Promise<ProvisioningRecord | undefined> {
    const changed = this.provisioning.change(id, (record) => {
      if (whileRunning && record.state !== 'running') return undefined;
      return stored(withPatch(record, patch));
    });
    return changed ? this.provisioning.get(id) : undefined;
  }

  watchProvisioning(on: (record: ProvisioningRecord) => void): Watching {
    const stop = this.provisioning.watch((record) => on(record));
    return { ready: Promise.resolve(), close: async () => { stop(); } };
  }
}
