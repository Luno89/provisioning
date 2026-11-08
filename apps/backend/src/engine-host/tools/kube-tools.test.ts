import { describe, it, expect, vi } from 'vitest';
import { createKubeTools, type KubeAccess } from './kube-tools.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import type { AccessRequest } from '@koala/harness-types';
import { principalOf } from '../../platform/lib/permissions.js';

const CLUSTERS: ClusterMetadata[] = [
  { id: 'machine-koala', name: 'koala', provider: 'machine', machineId: 'koala', status: 'healthy', ownerId: 'u1', capacity: { cpuCores: 16, ramGb: 64 } },
  { id: 'c2', name: 'dev-1', provider: 'machine', machineId: 'dev-1', status: 'healthy', ownerId: 'u1' },
  { id: 'machine-box', name: 'box', provider: 'machine', machineId: 'box', status: 'healthy', ownerId: 'u2' },
];
const DEPLOYMENTS = [
  { id: 'Billing', name: 'Billing', clusterId: 'machine-koala', ownerId: 'u1', appType: 'gitapp', status: 'unhealthy', healthReason: 'CrashLoopBackOff' },
  { id: 'Theirs', name: 'Theirs', clusterId: 'machine-box', ownerId: 'u2', appType: 'wordpress', status: 'running' },
] as unknown as DeploymentMetadata[];

function tools(open: string[] = []) {
  const ran: { cluster: string; argv: string[] }[] = [];
  const requests: AccessRequest[] = [];
  const access: KubeAccess = {
    clusters: async (ownerId: string) => CLUSTERS.filter((cluster) => cluster.ownerId === ownerId),
    ownClusterId: () => 'machine-koala',
    deployments: async () => DEPLOYMENTS,
    kubectl: vi.fn(async (cluster: ClusterMetadata, argv: string[]) => { ran.push({ cluster: cluster.name, argv }); return `${argv[0]} output`; }),
    principal: async (ownerId: string) => principalOf({ id: ownerId }, { role: 'instance', instanceOwnerId: 'u1' }),
    openNamespaces: async () => open,
    accessRequests: { list: async () => requests, save: async (request: AccessRequest) => { requests.push(request); } },
  };
  const handlers = createKubeTools({ access });
  const call = (name: string, parsed: Record<string, unknown> = {}, ownerId = 'u1') =>
    handlers[name]!({ name, parsed, driver: undefined, caller: { ownerId, conversationId: 'c1' } });
  return { call, ran, requests };
}

describe('cluster diagnostics', () => {
  it('lists the person\'s clusters and deployments, not anyone else\'s', async () => {
    const { call } = tools();
    const out = await call('list_infrastructure');
    expect(out.content).toContain('- koala (the cluster this Koala runs in, healthy, 16 cores, 64 GB)');
    expect(out.content).toContain('  - Billing: gitapp, unhealthy — CrashLoopBackOff');
    expect(out.content).toContain('- dev-1 (machine, healthy)\n  - nothing deployed');
    expect(out.content).not.toContain('Theirs');
  });

  it('reads logs and events on the cluster the deployment runs on', async () => {
    const { call, ran } = tools();
    await call('get_logs', { deployment: 'billing' });
    await call('get_events', { deployment: 'Billing' });
    expect(ran).toEqual([
      { cluster: 'koala', argv: ['logs', '-n', 'billing', '--all-containers', '--prefix', '--tail', '60', '-l', 'app'] },
      { cluster: 'koala', argv: ['get', 'events', '-n', 'billing', '--sort-by=.lastTimestamp'] },
    ]);
  });

  it('refuses someone else\'s deployment by naming the person\'s own', async () => {
    const { call, ran } = tools();
    const out = await call('get_logs', { deployment: 'Theirs' });
    expect(out.digest).toContain('you have no deployment called "Theirs" — yours are: Billing');
    expect(ran).toEqual([]);
  });

  it('inspects read-only and never reads a Secret', async () => {
    const { call, ran } = tools();
    expect((await call('inspect_resources', { verb: 'get', resource: 'pods', deployment: 'Billing' })).ok).toBe(true);
    expect((await call('inspect_resources', { verb: 'get', resource: 'nodes', cluster: 'dev-1' })).ok).toBe(true);
    expect((await call('inspect_resources', { verb: 'get', resource: 'secrets', deployment: 'Billing' })).digest).toContain('cannot be read');
    expect(ran.map((entry) => `${entry.cluster}: ${entry.argv.join(' ')}`)).toEqual(['koala: get pods -n billing', 'dev-1: get nodes']);
  });

  it('measures a cluster, defaulting to the one Koala runs in, or one deployment', async () => {
    const { call, ran } = tools();
    await call('cluster_capacity');
    await call('cluster_capacity', { deployment: 'Billing' });
    expect(ran.map((entry) => `${entry.cluster}: ${entry.argv.join(' ')}`)).toEqual(['koala: top nodes', 'koala: get nodes -o wide', 'koala: top pods -n billing']);
  });

  it('reads all of a cluster only for whoever owns it, the one Koala runs in included, and their own app for them', async () => {
    const { call, ran } = tools();
    expect((await call('inspect_resources', { verb: 'get', resource: 'nodes', cluster: 'koala' }, 'u2')).digest).toBe('you have no cluster called "koala" — yours are: box');
    expect((await call('inspect_resources', { verb: 'get', resource: 'pods', deployment: 'Theirs' }, 'u2')).ok).toBe(true);
    await call('cluster_capacity', {}, 'u2');
    expect(ran.map((entry) => `${entry.cluster}: ${entry.argv.join(' ')}`)).toEqual(['box: get pods -n theirs', 'box: top nodes', 'box: get nodes -o wide']);
    expect((await call('inspect_resources', { verb: 'get', resource: 'nodes', cluster: 'koala' }, 'u1')).ok).toBe(true);
  });
});

describe('platform namespaces', () => {
  it('stay closed until opened for the conversation', async () => {
    const { call, ran } = tools();
    expect((await call('inspect_resources', { verb: 'get', resource: 'pods', namespace: 'monitoring' })).digest).toContain('not open in this conversation');
    expect(ran).toEqual([]);
  });

  it('are read on the cluster Koala runs in once open, and a pod must be named for logs', async () => {
    const { call, ran } = tools(['monitoring']);
    await call('inspect_resources', { verb: 'get', resource: 'pods', namespace: 'monitoring' });
    expect((await call('get_logs', { namespace: 'monitoring' })).digest).toContain('name the pod or workload');
    await call('get_logs', { namespace: 'monitoring', name: 'deployment/grafana' });
    expect(ran.map((entry) => `${entry.cluster}: ${entry.argv.join(' ')}`)).toEqual([
      'koala: get pods -n monitoring',
      'koala: logs -n monitoring deployment/grafana --all-containers --prefix --tail 60',
    ]);
  });

  it('are not read for someone the cluster Koala runs in does not belong to, even once open', async () => {
    const { call, ran } = tools(['monitoring']);
    expect((await call('inspect_resources', { verb: 'get', resource: 'pods', namespace: 'monitoring' }, 'u2')).digest).toBe('the cluster this Koala runs in is not one of yours, so its platform namespaces cannot be opened for you');
    expect(ran).toEqual([]);
  });

  it('are asked for only by an admin, never include infisical, and are asked once', async () => {
    const { call, requests } = tools();
    expect((await call('request_cluster_access', { namespaces: ['monitoring'], why: 'check prometheus' }, 'u2')).digest).toContain('Only the operator of this server');
    expect((await call('request_cluster_access', { namespaces: ['infisical'], why: 'x' })).digest).toContain('never opens');
    expect((await call('request_cluster_access', { namespaces: ['billing'], why: 'x' })).digest).toContain('not a platform namespace');
    await call('request_cluster_access', { namespaces: ['monitoring'], why: 'check prometheus' });
    expect((await call('request_cluster_access', { namespaces: ['monitoring'], why: 'again' })).content).toContain('Already asked');
    expect(requests).toMatchObject([{ namespaces: ['monitoring'], status: 'requested', conversationId: 'c1' }]);
  });
});
