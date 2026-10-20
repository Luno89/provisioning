import { describe, expect, it } from 'vitest';
import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js';
import { ClusterContentsService, nodesFrom } from './ClusterContentsService.js';
import { metricsOf, type PrometheusClient, type Viewer } from './MonitoringService.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const system = { id: 'sys', name: 'system', status: 'healthy', isSystem: true } as ClusterMetadata;
const mine = { id: 'c1', name: 'mine', status: 'healthy', ownerId: 'me' } as ClusterMetadata;

const podsJson = JSON.stringify({ items: [
  { metadata: { name: 'shop-0', namespace: 'shop', creationTimestamp: '2026-10-01T00:00:00Z', ownerReferences: [{ kind: 'StatefulSet', name: 'shop', controller: true }] }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] } },
  { metadata: { name: 'theirs-0', namespace: 'theirs', creationTimestamp: '2026-10-01T00:00:00Z' }, status: { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 9, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } },
  { metadata: { name: 'grafana-x-1', namespace: 'monitoring', creationTimestamp: '2026-10-01T00:00:00Z', labels: { 'pod-template-hash': 'x' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'kube-prometheus-stack-grafana-x', controller: true }] }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] } },
] });
const namespacesJson = JSON.stringify({ items: [{ metadata: { name: 'shop' } }, { metadata: { name: 'theirs' } }, { metadata: { name: 'monitoring' } }] });
const nodesJson = JSON.stringify({ items: [{ metadata: { name: 'n1', labels: { 'node-role.kubernetes.io/control-plane': 'true' } }, status: { conditions: [{ type: 'Ready', status: 'True' }], capacity: { cpu: '16', memory: '65536Mi', 'nvidia.com/gpu': '2' }, nodeInfo: { kubeletVersion: 'v1.33.1+k3s1' } } }] });

function setUp(owns: (viewer: Viewer, cluster: ClusterMetadata) => boolean) {
  const calls: string[] = [];
  const prometheus: PrometheusClient = {
    query: async (query) => (query.includes('memory') ? [{ metric: { namespace: 'shop', pod: 'shop-0' }, value: 1024 }] : []),
    range: async () => [],
    alerts: async () => [],
  };
  const service = new ClusterContentsService({
    monitoring: { clustersOf: async () => [system, mine], ownsCluster: owns, reach: async () => ({ metrics: metricsOf(prometheus) }) },
    deployments: async () => [
      { id: 'd1', name: 'shop', namespace: 'shop', clusterId: 'sys', ownerId: 'me', status: 'running' },
      { id: 'd2', name: 'theirs', namespace: 'theirs', clusterId: 'sys', ownerId: 'you', status: 'running' },
    ] as DeploymentMetadata[],
    kubectl: async (_cluster, args) => {
      calls.push(args.join(' '));
      return args[1] === 'pods' ? podsJson : args[1] === 'namespaces' ? namespacesJson : nodesJson;
    },
    helm: async () => JSON.stringify([{ name: 'kube-prometheus-stack', namespace: 'monitoring', status: 'deployed', chart: 'kube-prometheus-stack-79.0.0', app_version: 'v0.86.0' }]),
    labelOf: (id) => id,
    now: () => NOW,
  });
  return { service, calls };
}

describe('what is on a cluster', () => {
  it('shows its owner every workload, with the platform services, Helm releases and nodes', async () => {
    const { service } = setUp(() => true);
    const contents = await service.contents({ id: 'admin' }, 'sys');
    expect(contents.workloads.map((workload) => [workload.group, workload.name, workload.state])).toEqual([
      ['apps', 'theirs-0', 'down'], ['apps', 'shop', 'ok'], ['platform', 'kube-prometheus-stack-grafana', 'ok'],
    ]);
    expect(contents.workloads.find((workload) => workload.name === 'shop')?.memoryBytes).toBe(1024);
    expect(contents.services?.find((service) => service.key === 'grafana')).toMatchObject({ installed: true, state: 'ok', pods: { total: 1, ready: 1 }, dashboard: true, access: 'Opens signed in as admin.', release: { version: 'v0.86.0' } });
    expect(contents.services?.find((service) => service.key === 'gitea')).toMatchObject({ installed: false, state: 'absent', dashboard: false });
    expect(contents.nodes).toEqual([{ name: 'n1', ready: true, roles: ['control-plane'], version: 'v1.33.1+k3s1', cpuCores: 16, memoryBytes: 65536 * 1024 ** 2, gpus: 2 }]);
    expect(contents.releases).toHaveLength(1);
  });

  it('shows anyone else only their own, and no services, releases or nodes', async () => {
    const { service } = setUp(() => false);
    const contents = await service.contents({ id: 'me' }, 'sys');
    expect(contents.workloads.map((workload) => workload.name)).toEqual(['shop']);
    expect(contents.services).toBeUndefined();
    expect(contents.nodes).toBeUndefined();
    expect(contents.releases).toBeUndefined();
  });

  it('reads a cluster once while the read is fresh, and lists what is broken across clusters', async () => {
    const { service, calls } = setUp(() => true);
    await service.contents({ id: 'admin' }, 'sys');
    await service.contents({ id: 'admin' }, 'sys');
    expect(calls.filter((call) => call.startsWith('get pods'))).toHaveLength(1);
    const broken = await service.broken({ id: 'admin' });
    expect(broken.map((workload) => [workload.clusterId, workload.name])).toEqual([['sys', 'theirs-0'], ['c1', 'theirs-0']]);
  });

  it('refuses a cluster the person cannot see', async () => {
    const { service } = setUp(() => true);
    await expect(service.contents({ id: 'me' }, 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('reads nodes without GPUs too', () => {
    expect(nodesFrom(JSON.stringify({ items: [{ metadata: { name: 'n' }, status: { conditions: [{ type: 'Ready', status: 'False' }], capacity: { cpu: '500m' } } }] })))
      .toEqual([{ name: 'n', ready: false, roles: [], cpuCores: 0.5 }]);
  });
});
