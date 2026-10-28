import { describe, it, expect, vi } from 'vitest';
import { createKubeTools, type KubeAccess } from './kube-tools.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import type { AccessRequest } from '@koala/harness-types';
import { principalOf } from '../../platform/lib/permissions.js';

const CLUSTERS: ClusterMetadata[] = [
  { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d', status: 'healthy', isSystem: true, capacity: { cpuCores: 16, ramGb: 64 } },
  { id: 'c2', name: 'dev-1', provider: 'k3d', status: 'healthy', ownerId: 'u1' },
];
const DEPLOYMENTS = [
  { id: 'Billing', name: 'Billing', clusterId: 'provisioning-lunorica', ownerId: 'u1', appType: 'gitapp', status: 'unhealthy', healthReason: 'CrashLoopBackOff' },
  { id: 'Theirs', name: 'Theirs', clusterId: 'provisioning-lunorica', ownerId: 'u2', appType: 'wordpress', status: 'running' },
] as unknown as DeploymentMetadata[];

function tools(open: string[] = []) {
  const ran: { cluster: string; argv: string[] }[] = [];
  const requests: AccessRequest[] = [];
  const access: KubeAccess = {
    clusters: async () => CLUSTERS,
    deployments: async () => DEPLOYMENTS,
    kubectl: vi.fn(async (cluster: ClusterMetadata, argv: string[]) => { ran.push({ cluster: cluster.name, argv }); return `${argv[0]} output`; }),
    principal: async (ownerId: string) => principalOf({ id: ownerId, isAdmin: ownerId === 'u1' }, { role: 'combined' }),
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
    expect(out.content).toContain('- provisioning-lunorica (the always-on management cluster, healthy, 16 cores, 64 GB)');
    expect(out.content).toContain('  - Billing: gitapp, unhealthy — CrashLoopBackOff');
    expect(out.content).toContain('- dev-1 (k3d, healthy)\n  - nothing deployed');
    expect(out.content).not.toContain('Theirs');
  });

  it('reads logs and events on the cluster the deployment runs on', async () => {
    const { call, ran } = tools();
    await call('get_logs', { deployment: 'billing' });
    await call('get_events', { deployment: 'Billing' });
    expect(ran).toEqual([
      { cluster: 'provisioning-lunorica', argv: ['logs', '-n', 'billing', '--all-containers', '--prefix', '--tail', '60', '-l', 'app'] },
      { cluster: 'provisioning-lunorica', argv: ['get', 'events', '-n', 'billing', '--sort-by=.lastTimestamp'] },
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
    expect(ran.map((entry) => `${entry.cluster}: ${entry.argv.join(' ')}`)).toEqual(['provisioning-lunorica: get pods -n billing', 'dev-1: get nodes']);
  });

  it('measures a cluster, defaulting to the management cluster, or one deployment', async () => {
    const { call, ran } = tools();
    await call('cluster_capacity');
    await call('cluster_capacity', { deployment: 'Billing' });
    expect(ran.map((entry) => entry.argv.join(' '))).toEqual(['top nodes', 'get nodes -o wide', 'top pods -n billing']);
  });

  it('reads all of the system cluster only for its operator, and anyone\'s own app on it for them', async () => {
    const { call, ran } = tools();
    expect((await call('inspect_resources', { verb: 'get', resource: 'nodes', cluster: 'provisioning-lunorica' }, 'u2')).digest).toBe('only whoever runs provisioning-lunorica reads all of it; name one of your deployments there instead');
    expect((await call('inspect_resources', { verb: 'get', resource: 'namespaces', cluster: 'provisioning-lunorica' }, 'u2')).ok).toBe(false);
    expect((await call('cluster_capacity', {}, 'u2')).ok).toBe(false);
    expect((await call('inspect_resources', { verb: 'get', resource: 'pods', deployment: 'Theirs' }, 'u2')).ok).toBe(true);
    expect(ran.map((entry) => entry.argv.join(' '))).toEqual(['get pods -n theirs']);
    expect((await call('inspect_resources', { verb: 'get', resource: 'nodes', cluster: 'provisioning-lunorica' }, 'u1')).ok).toBe(true);
  });
});

describe('platform namespaces', () => {
  it('stay closed until opened for the conversation', async () => {
    const { call, ran } = tools();
    expect((await call('inspect_resources', { verb: 'get', resource: 'pods', namespace: 'monitoring' })).digest).toContain('not open in this conversation');
    expect(ran).toEqual([]);
  });

  it('are read on the management cluster once open, and a pod must be named for logs', async () => {
    const { call, ran } = tools(['monitoring']);
    await call('inspect_resources', { verb: 'get', resource: 'pods', namespace: 'monitoring' });
    expect((await call('get_logs', { namespace: 'monitoring' })).digest).toContain('name the pod or workload');
    await call('get_logs', { namespace: 'monitoring', name: 'deployment/grafana' });
    expect(ran.map((entry) => `${entry.cluster}: ${entry.argv.join(' ')}`)).toEqual([
      'provisioning-lunorica: get pods -n monitoring',
      'provisioning-lunorica: logs -n monitoring deployment/grafana --all-containers --prefix --tail 60',
    ]);
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
