import { describe, expect, it } from 'vitest';
import type { AccessRequest, EgressGrantRecord, EgressRequest } from '@koala/harness-types';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import type { StoredAppSpec } from '../lib/app-spec.js';
import type { ClusterProviderSpec } from '../lib/cluster-providers.js';
import { SERVER_ORDER_LOG_LINES, type ServerOrder } from '../lib/server-orders.js';
import type { BindingTypeRecord } from '../lib/service-binding.js';
import type { WorkFailure } from '../lib/work-failures.js';
import type { InfrastructureStore } from '../store.js';

const cluster = (id: string, extra: Partial<ClusterMetadata> = {}): ClusterMetadata => ({ id, name: `cluster-${id}`, provider: 'k3d', status: 'healthy', ownerId: 'owner-1', ...extra });

const deployment = (id: string, extra: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({
  id, name: `app-${id}`, clusterId: 'c1', strategy: 'helm', status: 'running', ownerId: 'owner-1', ...extra,
});

const failure = (id: string, extra: Partial<WorkFailure> = {}): WorkFailure => ({
  id, ownerId: 'owner-1', workflowId: `wf-${id}`, kind: 'deploy', title: `title ${id}`, opens: { view: 'infrastructure' }, reason: 'it broke', failedAt: '2026-10-10T00:00:00.000Z', ...extra,
} as WorkFailure);

const grant = (id: string, extra: Partial<EgressGrantRecord> = {}): EgressGrantRecord => ({
  id, ownerId: 'owner-1', agentSlug: 'executor', host: 'example.com', approvedBy: 'owner-1', approvedAt: '2026-10-10T00:00:00.000Z', ...extra,
});

const egress = (id: string, extra: Partial<EgressRequest> = {}): EgressRequest => ({
  id, ownerId: 'owner-1', agentSlug: 'executor', host: 'example.com', why: 'to fetch', status: 'requested', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...extra,
});

const access = (id: string, extra: Partial<AccessRequest> = {}): AccessRequest => ({
  id, ownerId: 'owner-1', conversationId: 'chat-1', namespaces: ['apps'], why: 'to look', status: 'requested', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...extra,
});

const binding = (id: string, extra: Partial<BindingTypeRecord> = {}): BindingTypeRecord => ({ id, label: `Label ${id}`, ...extra });

const spec = (id: string, extra: Partial<StoredAppSpec> = {}): StoredAppSpec => ({ id, label: `App ${id}`, builtIn: false, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...extra });

const provider = (value: string, extra: Partial<ClusterProviderSpec> = {}): ClusterProviderSpec => ({ value, label: `Provider ${value}`, hasCatalog: false, ...extra });

const order = (id: string, extra: Partial<ServerOrder> = {}): ServerOrder => ({
  id, ownerId: 'owner-1', provider: 'ovh', purpose: 'root', subsidiary: 'FR', planCode: 'vps-1', planLabel: 'VPS 1', datacenter: 'GRA', domain: 'koala.example', ingressDomain: 'people.example', acmeEmail: 'a@koala.example',
  dns: { domain: 'koala.example', ingress: 'people.example' },
  quote: { currency: 'EUR', withoutTax: 5, tax: 1, withTax: 6, monthly: 6, setupFee: 0, lines: [{ description: 'VPS', amount: 5 }], contracts: [] },
  quotedAt: '2026-10-10T00:00:00.000Z', state: 'quoted', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...extra,
});

const SECRET_FIELDS = {
  vllmHfToken: 'hf-1', tabbyHfToken: 'hf-2', searxngSecretKey: 'sx', crawl4aiApiToken: 'c4', minioRootPassword: 'minio-pw', nextcloudAdminPassword: 'nc-admin',
  nextcloudDbPassword: 'nc-db', nextcloudDbRootPassword: 'nc-root', hermesDashboardPassword: 'hermes-pw', qdrantApiKey: 'q-key', quickwitS3SecretKey: 'qw', webuiWebSearchApiKey: 'web',
} satisfies Partial<DeploymentMetadata>;

function hearing<T>(until: (heard: T[]) => boolean): { heard: T[]; on: (item: T) => void; done: Promise<void> } {
  const heard: T[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  return { heard, on: (item) => { heard.push(item); if (until(heard)) finish(); }, done };
}

export function infrastructureStoreContract(make: () => Promise<InfrastructureStore>): void {
  describe('following work', () => {
    it('hears a cluster or an app come to name a workflow it is waiting on, from any write, and never one that names none or has finished', async () => {
      const store = await make();
      const listening = hearing<string>((heard) => heard.includes('deployment d2 deploying') && heard.includes('cluster c1 provisioning'));
      const watching = store.watchFollowed((followed) => listening.on(`${followed.kind} ${followed.record.id} ${followed.record.status}`));
      await watching.ready;

      await store.saveCluster(cluster('c1', { status: 'provisioning' }));
      await store.saveClusterInfo({ id: 'c1', temporalWorkflowId: 'wf-c1' });
      await store.saveDeploymentInfo({ id: 'd1', name: 'shop', clusterId: 'c1', status: 'deploying', temporalWorkflowId: 'wf-d1' });
      await store.saveDeploymentInfo({ id: 'd1', status: 'running' });
      await store.saveDeploymentInfo({ id: 'd2', name: 'blog', clusterId: 'c1', status: 'deploying', temporalWorkflowId: 'wf-d2' });
      await listening.done;
      await watching.close();

      expect(listening.heard.filter((line) => line.startsWith('deployment'))).toEqual(['deployment d1 deploying', 'deployment d2 deploying']);
      expect(listening.heard.filter((line) => line.startsWith('cluster'))).toEqual(['cluster c1 provisioning']);
    });
  });

  describe('clusters', () => {
    it('keeps a cluster as it was saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      await store.saveCluster(cluster('a', { machineId: 'desk', capacity: { cpuCores: 4, ramGb: 8 } }));
      await store.saveCluster(cluster('b'));
      expect(await store.getClusters()).toEqual([cluster('a', { machineId: 'desk', capacity: { cpuCores: 4, ramGb: 8 } }), cluster('b')]);
      await store.saveCluster(cluster('a', { status: 'failed' }));
      expect((await store.getClusters()).find((stored) => stored.id === 'a')).toEqual(cluster('a', { status: 'failed' }));
      await store.deleteCluster('a');
      await store.deleteCluster('never-was');
      expect((await store.getClusters()).map((stored) => stored.id)).toEqual(['b']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveCluster(cluster('a', { capacity: { cpuCores: 4, ramGb: 8 } }));
      const [read] = await store.getClusters();
      read!.name = 'changed';
      read!.capacity!.cpuCores = 99;
      expect((await store.getClusters())[0]).toEqual(cluster('a', { capacity: { cpuCores: 4, ramGb: 8 } }));
    });

    it('refuses two clusters with one name', async () => {
      const store = await make();
      await store.saveCluster(cluster('a', { name: 'shared' }));
      await expect(store.saveCluster(cluster('b', { name: 'shared' }))).rejects.toThrow();
      await store.saveCluster(cluster('a', { name: 'shared', status: 'failed' }));
      expect((await store.getClusters()).map((stored) => stored.id)).toEqual(['a']);
    });

    it('patches only the fields named and leaves the rest', async () => {
      const store = await make();
      await store.saveCluster(cluster('a', { meshIp: '100.64.0.1' }));
      await store.patchCluster('a', { status: 'destroying', lastSyncedAt: '2026-10-11T00:00:00.000Z' });
      expect((await store.getClusters())[0]).toEqual(cluster('a', { meshIp: '100.64.0.1', status: 'destroying', lastSyncedAt: '2026-10-11T00:00:00.000Z' }));
    });

    it('patches nothing for an empty patch, an id inside the patch, or a cluster it does not have', async () => {
      const store = await make();
      await store.saveCluster(cluster('a'));
      await store.patchCluster('a', {});
      await store.patchCluster('a', { id: 'other' });
      await store.patchCluster('gone', { status: 'failed' });
      expect(await store.getClusters()).toEqual([cluster('a')]);
    });

    it('sets a cluster\'s progress, whole, and only for a cluster it has', async () => {
      const store = await make();
      await store.saveCluster(cluster('a', { progress: { step: 'creating-cluster', message: 'first', timestamp: 't1' } }));
      await store.updateClusterProgress('a', { step: 'deploying-cdktf', message: 'second', timestamp: 't2' });
      await store.updateClusterProgress('gone', { step: 'x', message: 'y', timestamp: 't3' });
      expect(await store.getClusters()).toEqual([cluster('a', { progress: { step: 'deploying-cdktf', message: 'second', timestamp: 't2' } })]);
    });

    it('makes a cluster from partial information with a new id and the defaults', async () => {
      const store = await make();
      const made = await store.saveClusterInfo({ name: 'fresh' });
      expect(made).toMatchObject({ name: 'fresh', provider: 'k3d', status: 'provisioning' });
      expect(made.id).toMatch(/\S/);
      expect(await store.getClusters()).toEqual([made]);
    });

    it('merges partial information into the cluster it names, skipping fields given as undefined', async () => {
      const store = await make();
      await store.saveCluster(cluster('a', { meshIp: '100.64.0.1', provider: 'hetzner' }));
      const merged = await store.saveClusterInfo({ id: 'a', status: 'failed', meshIp: undefined });
      expect(merged).toEqual(cluster('a', { meshIp: '100.64.0.1', provider: 'hetzner', status: 'failed' }));
      expect(await store.getClusters()).toEqual([merged]);
    });

    it('makes a cluster of an id it has not seen from the information given', async () => {
      const store = await make();
      const made = await store.saveClusterInfo({ id: 'chosen', name: 'n', provider: 'hetzner' });
      expect(made).toEqual({ id: 'chosen', name: 'n', provider: 'hetzner', status: 'provisioning' });
    });

    it('leaves out a field saved as undefined, and removes one patched to undefined', async () => {
      const store = await make();
      await store.saveCluster({ ...cluster('a'), note: undefined });
      expect((await store.getClusters())[0]).not.toHaveProperty('note');
      await store.patchCluster('a', { note: 'kept' } as never);
      expect((await store.getClusters())[0]).toHaveProperty('note', 'kept');
      await store.patchCluster('a', { note: undefined } as never);
      expect((await store.getClusters())[0]).not.toHaveProperty('note');
    });
  });

  describe('deployments', () => {
    it('patches only an app\'s status and health reason, and never makes an app it does not have', async () => {
      const store = await make();
      await store.saveDeployment(deployment('a', { modules: ['x'], minioRootPassword: 'pw', healthReason: 'was down' }));
      await store.patchDeploymentHealth('a', { status: 'unhealthy', healthReason: 'its namespace is gone' });
      await store.patchDeploymentHealth('gone', { status: 'unhealthy', healthReason: 'its namespace is gone' });
      expect(await store.getDeployments()).toEqual([deployment('a', { modules: ['x'], minioRootPassword: 'pw', status: 'unhealthy', healthReason: 'its namespace is gone' })]);
      await store.patchDeploymentHealth('a', { healthReason: undefined });
      expect((await store.getDeployments())[0]).not.toHaveProperty('healthReason');
    });

    it('keeps a deployment as it was saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      await store.saveDeployment(deployment('a', { namespace: 'ns-a', modules: ['x'] }));
      await store.saveDeployment(deployment('b'));
      expect(await store.getDeployments()).toEqual([deployment('a', { namespace: 'ns-a', modules: ['x'] }), deployment('b')]);
      await store.saveDeployment(deployment('a', { status: 'failed' }));
      expect((await store.getDeployments()).find((stored) => stored.id === 'a')).toEqual(deployment('a', { status: 'failed' }));
      await store.deleteDeployment('a');
      await store.deleteDeployment('never-was');
      expect((await store.getDeployments()).map((stored) => stored.id)).toEqual(['b']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveDeployment(deployment('a', { modules: ['x'], minioRootPassword: 'pw' }));
      const [read] = await store.getDeployments();
      read!.name = 'changed';
      read!.modules!.push('y');
      read!.minioRootPassword = 'other';
      expect((await store.getDeployments())[0]).toEqual(deployment('a', { modules: ['x'], minioRootPassword: 'pw' }));
    });

    it('lets two owners each have an app of one name, and refuses one owner a second', async () => {
      const store = await make();
      await store.saveDeployment(deployment('a', { name: 'shop', ownerId: 'owner-1' }));
      await store.saveDeployment(deployment('b', { name: 'shop', ownerId: 'owner-2' }));
      await expect(store.saveDeployment(deployment('c', { name: 'shop', ownerId: 'owner-1' }))).rejects.toThrow();
      await store.saveDeployment(deployment('a', { name: 'shop', ownerId: 'owner-1', status: 'failed' }));
      expect((await store.getDeployments()).map((stored) => stored.id)).toEqual(['a', 'b']);
    });

    it('reads every secret field back as it was written', async () => {
      const store = await make();
      await store.saveDeployment(deployment('a', SECRET_FIELDS));
      expect((await store.getDeployments())[0]).toEqual(deployment('a', SECRET_FIELDS));
    });

    it('makes a deployment from partial information with a new id and the defaults', async () => {
      const store = await make();
      const made = await store.saveDeploymentInfo({ name: 'fresh', ownerId: 'owner-1' });
      expect(made).toMatchObject({ name: 'fresh', clusterId: '', strategy: 'helm', status: 'deploying' });
      expect(made.id).toMatch(/\S/);
      expect(await store.getDeployments()).toEqual([made]);
    });

    it('merges partial information into the deployment it names, secrets included', async () => {
      const store = await make();
      await store.saveDeployment(deployment('a', { nextcloudAdminPassword: 'admin-pw', url: 'http://a' }));
      const merged = await store.saveDeploymentInfo({ id: 'a', searxngSecretKey: 'sx', url: undefined, status: 'failed' });
      expect(merged).toEqual(deployment('a', { nextcloudAdminPassword: 'admin-pw', searxngSecretKey: 'sx', url: 'http://a', status: 'failed' }));
      expect(await store.getDeployments()).toEqual([merged]);
    });

    it('removes every deployment of a cluster and says how many', async () => {
      const store = await make();
      await store.saveDeployment(deployment('a', { clusterId: 'c1' }));
      await store.saveDeployment(deployment('b', { clusterId: 'c1' }));
      await store.saveDeployment(deployment('c', { clusterId: 'c2' }));
      expect(await store.deleteDeploymentsOfCluster('c1')).toBe(2);
      expect(await store.deleteDeploymentsOfCluster('c1')).toBe(0);
      expect((await store.getDeployments()).map((stored) => stored.id)).toEqual(['c']);
    });

    it('has nothing left to seal when everything was saved through it', async () => {
      const store = await make();
      await store.saveDeployment(deployment('a', { minioRootPassword: 'pw' }));
      await store.saveDeployment(deployment('b'));
      expect(await store.sealDeploymentSecrets()).toBe(0);
      expect((await store.getDeployments()).find((stored) => stored.id === 'a')?.minioRootPassword).toBe('pw');
    });
  });

  describe('app specs', () => {
    it('keeps a spec as it was saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      await store.saveAppSpec(spec('a', { provides: ['db'] }));
      await store.saveAppSpec(spec('b'));
      expect(await store.getAppSpecs()).toEqual([spec('a', { provides: ['db'] }), spec('b')]);
      const bare = spec('a');
      delete bare.label;
      await store.saveAppSpec(bare);
      expect((await store.getAppSpecs()).find((stored) => stored.id === 'a')).toEqual(bare);
      await store.deleteAppSpec('a');
      await store.deleteAppSpec('never-was');
      expect((await store.getAppSpecs()).map((stored) => stored.id)).toEqual(['b']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveAppSpec(spec('a', { provides: ['db'] }));
      const [read] = await store.getAppSpecs();
      read!.provides!.push('cache');
      expect((await store.getAppSpecs())[0]?.provides).toEqual(['db']);
    });
  });

  describe('cluster providers', () => {
    it('keeps a provider by its value without an id, and replaces it whole when saved again', async () => {
      const store = await make();
      await store.saveClusterProvider(provider('mine', { hint: 'first', credentialKey: 'k' }));
      await store.saveClusterProvider(provider('other'));
      expect(await store.getClusterProviders()).toEqual([provider('mine', { hint: 'first', credentialKey: 'k' }), provider('other')]);
      await store.saveClusterProvider(provider('mine', { hasCatalog: true }));
      expect((await store.getClusterProviders()).find((stored) => stored.value === 'mine')).toEqual(provider('mine', { hasCatalog: true }));
      expect(await store.getClusterProviders()).toHaveLength(2);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveClusterProvider(provider('mine'));
      (await store.getClusterProviders())[0]!.label = 'changed';
      expect((await store.getClusterProviders())[0]?.label).toBe('Provider mine');
    });
  });

  describe('pending approvals', () => {
    const approval = (id: string, extra: Record<string, unknown> = {}) => ({ id, ownerId: 'owner-1', leafId: 'leaf-1', command: 'ls', status: 'pending' as const, createdAt: '2026-10-10T00:00:00.000Z', ...extra });

    it('keeps an approval as it was saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      await store.savePendingApproval(approval('a'));
      await store.savePendingApproval(approval('b'));
      await store.savePendingApproval(approval('a', { status: 'approved', decidedAt: '2026-10-11T00:00:00.000Z' }));
      expect(await store.getPendingApprovals()).toEqual([approval('a', { status: 'approved', decidedAt: '2026-10-11T00:00:00.000Z' }), approval('b')]);
      await store.deletePendingApproval('a');
      await store.deletePendingApproval('never-was');
      expect((await store.getPendingApprovals()).map((stored) => stored.id)).toEqual(['b']);
    });
  });

  describe('work failures', () => {
    it('lists the newest failure first, for everyone or for one owner', async () => {
      const store = await make();
      await store.addWorkFailure(failure('old', { failedAt: '2026-10-01T00:00:00.000Z' }));
      await store.addWorkFailure(failure('new', { failedAt: '2026-10-03T00:00:00.000Z', ownerId: 'owner-2' }));
      await store.addWorkFailure(failure('mid', { failedAt: '2026-10-02T00:00:00.000Z' }));
      expect((await store.getWorkFailures()).map((stored) => stored.id)).toEqual(['new', 'mid', 'old']);
      expect((await store.getWorkFailures('owner-1')).map((stored) => stored.id)).toEqual(['mid', 'old']);
      expect(await store.getWorkFailures('nobody')).toEqual([]);
    });

    it('records a failure once, never changing one it already has', async () => {
      const store = await make();
      await store.addWorkFailure(failure('a', { reason: 'first' }));
      await store.addWorkFailure(failure('a', { reason: 'second', clearedAt: '2026-10-12T00:00:00.000Z' }));
      expect(await store.getWorkFailures()).toEqual([failure('a', { reason: 'first' })]);
    });

    it('clears the named failures of an owner that are not cleared yet, and says how many', async () => {
      const store = await make();
      await store.addWorkFailure(failure('a', { failedAt: '2026-10-01T00:00:00.000Z' }));
      await store.addWorkFailure(failure('b', { failedAt: '2026-10-02T00:00:00.000Z' }));
      await store.addWorkFailure(failure('c', { failedAt: '2026-10-03T00:00:00.000Z', ownerId: 'owner-2' }));
      expect(await store.clearWorkFailures('owner-1', ['a', 'c', 'missing'], '2026-10-05T00:00:00.000Z')).toBe(1);
      expect(await store.clearWorkFailures('owner-1', ['a'], '2026-10-06T00:00:00.000Z')).toBe(0);
      expect(await store.clearWorkFailures('owner-1', [], '2026-10-06T00:00:00.000Z')).toBe(0);
      const byId = Object.fromEntries((await store.getWorkFailures()).map((stored) => [stored.id, stored.clearedAt]));
      expect(byId).toEqual({ a: '2026-10-05T00:00:00.000Z', b: undefined, c: undefined });
    });

    it('clears all of an owner\'s uncleared failures and none of anyone else\'s', async () => {
      const store = await make();
      await store.addWorkFailure(failure('a', { clearedAt: '2026-10-04T00:00:00.000Z' }));
      await store.addWorkFailure(failure('b'));
      await store.addWorkFailure(failure('c'));
      await store.addWorkFailure(failure('d', { ownerId: 'owner-2' }));
      expect(await store.clearWorkFailures('owner-1', 'all', '2026-10-05T00:00:00.000Z')).toBe(2);
      const byId = Object.fromEntries((await store.getWorkFailures()).map((stored) => [stored.id, stored.clearedAt]));
      expect(byId).toEqual({ a: '2026-10-04T00:00:00.000Z', b: '2026-10-05T00:00:00.000Z', c: '2026-10-05T00:00:00.000Z', d: undefined });
    });

    it('prunes the failures from before a time and keeps the rest', async () => {
      const store = await make();
      await store.addWorkFailure(failure('old', { failedAt: '2026-09-01T00:00:00.000Z' }));
      await store.addWorkFailure(failure('edge', { failedAt: '2026-10-01T00:00:00.000Z' }));
      await store.addWorkFailure(failure('new', { failedAt: '2026-10-02T00:00:00.000Z' }));
      await store.pruneWorkFailures('2026-10-01T00:00:00.000Z');
      expect((await store.getWorkFailures()).map((stored) => stored.id)).toEqual(['new', 'edge']);
    });
  });

  describe('egress grants', () => {
    it('keeps a grant as it was saved and replaces it whole when saved again', async () => {
      const store = await make();
      await store.saveEgressGrant(grant('a', { ports: [443], reason: 'fetch' }));
      await store.saveEgressGrant(grant('b', { ownerId: 'owner-2' }));
      await store.saveEgressGrant(grant('a', { revokedAt: '2026-10-11T00:00:00.000Z', revokedBy: 'owner-1' }));
      expect(await store.getEgressGrants()).toEqual([grant('a', { revokedAt: '2026-10-11T00:00:00.000Z', revokedBy: 'owner-1' }), grant('b', { ownerId: 'owner-2' })]);
    });

    it('lists one owner\'s grants when asked for them', async () => {
      const store = await make();
      await store.saveEgressGrant(grant('a'));
      await store.saveEgressGrant(grant('b', { ownerId: 'owner-2' }));
      expect((await store.getEgressGrants('owner-2')).map((stored) => stored.id)).toEqual(['b']);
      expect(await store.getEgressGrants('nobody')).toEqual([]);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveEgressGrant(grant('a', { ports: [443] }));
      (await store.getEgressGrants())[0]!.ports!.push(80);
      expect((await store.getEgressGrants())[0]?.ports).toEqual([443]);
    });
  });

  describe('egress requests', () => {
    it('lists an owner\'s requests oldest first', async () => {
      const store = await make();
      await store.saveEgressRequest(egress('late', { createdAt: '2026-10-03T00:00:00.000Z' }));
      await store.saveEgressRequest(egress('early', { createdAt: '2026-10-01T00:00:00.000Z' }));
      await store.saveEgressRequest(egress('other', { ownerId: 'owner-2', createdAt: '2026-10-02T00:00:00.000Z' }));
      expect((await store.getEgressRequests('owner-1')).map((stored) => stored.id)).toEqual(['early', 'late']);
    });

    it('narrows the list to a conversation, a tree, or both', async () => {
      const store = await make();
      await store.saveEgressRequest(egress('a', { conversationId: 'chat-1', createdAt: '2026-10-01T00:00:00.000Z' }));
      await store.saveEgressRequest(egress('b', { conversationId: 'chat-1', treeId: 'tree-1', createdAt: '2026-10-02T00:00:00.000Z' }));
      await store.saveEgressRequest(egress('c', { treeId: 'tree-1', createdAt: '2026-10-03T00:00:00.000Z' }));
      await store.saveEgressRequest(egress('d', { createdAt: '2026-10-04T00:00:00.000Z' }));
      expect((await store.getEgressRequests('owner-1', { conversationId: 'chat-1' })).map((stored) => stored.id)).toEqual(['a', 'b']);
      expect((await store.getEgressRequests('owner-1', { treeId: 'tree-1' })).map((stored) => stored.id)).toEqual(['b', 'c']);
      expect((await store.getEgressRequests('owner-1', { conversationId: 'chat-1', treeId: 'tree-1' })).map((stored) => stored.id)).toEqual(['b']);
      expect((await store.getEgressRequests('owner-1', { conversationId: undefined, treeId: undefined })).map((stored) => stored.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('finds one request only for its owner, and replaces it whole when saved again', async () => {
      const store = await make();
      await store.saveEgressRequest(egress('a', { ports: [443] }));
      expect(await store.getEgressRequest('owner-1', 'a')).toEqual(egress('a', { ports: [443] }));
      expect(await store.getEgressRequest('owner-2', 'a')).toBeUndefined();
      expect(await store.getEgressRequest('owner-1', 'missing')).toBeUndefined();
      await store.saveEgressRequest(egress('a', { status: 'allowed' }));
      expect(await store.getEgressRequest('owner-1', 'a')).toEqual(egress('a', { status: 'allowed' }));
    });
  });

  describe('access requests', () => {
    it('lists an owner\'s requests oldest first, narrowed to a conversation when asked', async () => {
      const store = await make();
      await store.saveAccessRequest(access('late', { createdAt: '2026-10-03T00:00:00.000Z' }));
      await store.saveAccessRequest(access('early', { createdAt: '2026-10-01T00:00:00.000Z', conversationId: 'chat-2' }));
      await store.saveAccessRequest(access('other', { ownerId: 'owner-2', createdAt: '2026-10-02T00:00:00.000Z' }));
      expect((await store.getAccessRequests('owner-1')).map((stored) => stored.id)).toEqual(['early', 'late']);
      expect((await store.getAccessRequests('owner-1', 'chat-1')).map((stored) => stored.id)).toEqual(['late']);
      expect(await store.getAccessRequests('owner-1', 'chat-9')).toEqual([]);
    });

    it('finds one request only for its owner, and replaces it whole when saved again', async () => {
      const store = await make();
      await store.saveAccessRequest(access('a', { runId: 'run-1' }));
      expect(await store.getAccessRequest('owner-1', 'a')).toEqual(access('a', { runId: 'run-1' }));
      expect(await store.getAccessRequest('owner-2', 'a')).toBeUndefined();
      expect(await store.getAccessRequest('owner-1', 'missing')).toBeUndefined();
      await store.saveAccessRequest(access('a', { status: 'granted' }));
      expect(await store.getAccessRequest('owner-1', 'a')).toEqual(access('a', { status: 'granted' }));
    });
  });

  describe('binding types', () => {
    it('keeps a type as it was saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      await store.saveBindingType(binding('a', { protocol: 'tcp', defaultPort: 5432, requiredKeys: ['host'] }));
      await store.saveBindingType(binding('b'));
      expect(await store.getBindingTypes()).toEqual([binding('a', { protocol: 'tcp', defaultPort: 5432, requiredKeys: ['host'] }), binding('b')]);
      await store.saveBindingType(binding('a'));
      expect((await store.getBindingTypes()).find((stored) => stored.id === 'a')).toEqual(binding('a'));
      await store.deleteBindingType('a');
      await store.deleteBindingType('never-was');
      expect((await store.getBindingTypes()).map((stored) => stored.id)).toEqual(['b']);
    });
  });

  describe('server orders', () => {
    it('lists an owner\'s orders newest first, without their log', async () => {
      const store = await make();
      await store.saveServerOrder(order('old', { createdAt: '2026-10-01T00:00:00.000Z', log: ['one'] }));
      await store.saveServerOrder(order('new', { createdAt: '2026-10-03T00:00:00.000Z', log: ['two'] }));
      await store.saveServerOrder(order('other', { ownerId: 'owner-2', createdAt: '2026-10-02T00:00:00.000Z' }));
      const listed = await store.getServerOrders('owner-1');
      expect(listed.map((stored) => stored.id)).toEqual(['new', 'old']);
      for (const stored of listed) expect(stored).not.toHaveProperty('log');
      expect(await store.getServerOrders('nobody')).toEqual([]);
    });

    it('finds one order whole, log included, and replaces it whole when saved again', async () => {
      const store = await make();
      await store.saveServerOrder(order('a', { log: ['one', 'two'], sshPrivateKey: 'key' }));
      expect(await store.getServerOrder('a')).toEqual(order('a', { log: ['one', 'two'], sshPrivateKey: 'key' }));
      expect(await store.getServerOrder('missing')).toBeUndefined();
      await store.saveServerOrder(order('a', { state: 'bought' }));
      expect(await store.getServerOrder('a')).toEqual(order('a', { state: 'bought' }));
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveServerOrder(order('a', { log: ['one'] }));
      const read = await store.getServerOrder('a');
      read!.log!.push('two');
      read!.quote.lines.push({ description: 'extra', amount: 1 });
      expect(await store.getServerOrder('a')).toEqual(order('a', { log: ['one'] }));
    });

    it('patches an order, stamps the time it was updated and answers with the order as it is now', async () => {
      const store = await make();
      await store.saveServerOrder(order('a', { log: ['one'] }));
      const before = Date.now();
      const patched = await store.patchServerOrder('a', { state: 'bought', orderId: 42, updatedAt: '1999-01-01T00:00:00.000Z' });
      expect(patched).toEqual({ ...order('a', { log: ['one'] }), state: 'bought', orderId: 42, updatedAt: patched?.updatedAt });
      expect(patched?.updatedAt).not.toBe('1999-01-01T00:00:00.000Z');
      expect(Date.parse(patched!.updatedAt)).toBeGreaterThanOrEqual(before);
      expect(await store.getServerOrder('a')).toEqual(patched);
    });

    it('patches nothing, and answers nothing, for an order it does not have', async () => {
      const store = await make();
      expect(await store.patchServerOrder('gone', { state: 'failed' })).toBeUndefined();
      expect(await store.getServerOrder('gone')).toBeUndefined();
    });

    it('appends lines to an order\'s log, in order, starting one that has none', async () => {
      const store = await make();
      await store.saveServerOrder(order('a'));
      await store.appendServerOrderLog('a', ['one']);
      await store.appendServerOrderLog('a', ['two', 'three']);
      await store.appendServerOrderLog('a', []);
      expect((await store.getServerOrder('a'))?.log).toEqual(['one', 'two', 'three']);
    });

    it('keeps only the last lines of a long log', async () => {
      const store = await make();
      await store.saveServerOrder(order('a'));
      await store.appendServerOrderLog('a', Array.from({ length: SERVER_ORDER_LOG_LINES - 1 }, (_, i) => `line ${i}`));
      await store.appendServerOrderLog('a', ['x', 'y', 'z']);
      const log = (await store.getServerOrder('a'))?.log ?? [];
      expect(log).toHaveLength(SERVER_ORDER_LOG_LINES);
      expect(log.slice(-3)).toEqual(['x', 'y', 'z']);
      expect(log[0]).toBe('line 2');
    });

    it('appends nothing for an order it does not have', async () => {
      const store = await make();
      await store.appendServerOrderLog('gone', ['one']);
      expect(await store.getServerOrder('gone')).toBeUndefined();
    });

    it('keeps the log through a patch', async () => {
      const store = await make();
      await store.saveServerOrder(order('a'));
      await store.appendServerOrderLog('a', ['one']);
      await store.patchServerOrder('a', { detail: 'waiting' });
      expect(await store.getServerOrder('a')).toMatchObject({ detail: 'waiting', log: ['one'] });
    });

    it('removes a field patched to undefined, as a bought order drops its cart', async () => {
      const store = await make();
      await store.saveServerOrder(order('a'));
      await store.patchServerOrder('a', { cartId: 'cart-1', detail: 'priced' });
      await store.patchServerOrder('a', { state: 'bought', cartId: undefined, detail: undefined });
      const stored = await store.getServerOrder('a');
      expect(stored).toMatchObject({ state: 'bought' });
      expect(stored).not.toHaveProperty('cartId');
      expect(stored).not.toHaveProperty('detail');
    });
  });

  describe('indexes', () => {
    it('can be asked for again without changing what is kept', async () => {
      const store = await make();
      await store.saveCluster(cluster('a'));
      await store.saveDeployment(deployment('a'));
      await store.ensureIndexes();
      expect(await store.getClusters()).toEqual([cluster('a')]);
      expect(await store.getDeployments()).toEqual([deployment('a')]);
    });
  });
}
