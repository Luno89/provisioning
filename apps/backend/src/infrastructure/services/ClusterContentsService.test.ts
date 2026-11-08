import { describe, expect, it } from 'vitest';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import { ClusterContentsService, nodesFrom } from './ClusterContentsService.js';
import { asPerson } from '../../platform/lib/permissions.js';
import { metricsOf, type PrometheusClient, type Viewer } from '../../monitoring/services/MonitoringService.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const koalas = { id: 'machine-koala', name: 'koala', provider: 'machine', machineId: 'koala', status: 'healthy', ownerId: 'admin' } as ClusterMetadata;
const mine = { id: 'c1', name: 'mine', status: 'healthy', ownerId: 'me' } as ClusterMetadata;

const podsJson = JSON.stringify({ items: [
  { metadata: { name: 'shop-0', namespace: 'shop', creationTimestamp: '2026-10-01T00:00:00Z', ownerReferences: [{ kind: 'StatefulSet', name: 'shop', controller: true }] }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] } },
  { metadata: { name: 'theirs-0', namespace: 'theirs', creationTimestamp: '2026-10-01T00:00:00Z' }, status: { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 9, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } },
  { metadata: { name: 'grafana-x-1', namespace: 'monitoring', creationTimestamp: '2026-10-01T00:00:00Z', labels: { 'pod-template-hash': 'x' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'kube-prometheus-stack-grafana-x', controller: true }] }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] } },
] });
const namespacesJson = JSON.stringify({ items: [{ metadata: { name: 'shop' } }, { metadata: { name: 'theirs' } }, { metadata: { name: 'monitoring' } }] });
const nodesJson = JSON.stringify({ items: [{ metadata: { name: 'n1', labels: { 'node-role.kubernetes.io/control-plane': 'true' } }, status: { conditions: [{ type: 'Ready', status: 'True' }], capacity: { cpu: '16', memory: '65536Mi', 'nvidia.com/gpu': '2' }, nodeInfo: { kubeletVersion: 'v1.33.1+k3s1' } } }] });

function setUp(owns: (viewer: Viewer, cluster: ClusterMetadata) => boolean, answers: (cluster: ClusterMetadata) => boolean = () => true) {
  const calls: string[] = [];
  const prometheus: PrometheusClient = {
    query: async (query) => (query.includes('memory') ? [{ metric: { namespace: 'shop', pod: 'shop-0' }, value: 1024 }] : []),
    range: async () => [],
    alerts: async () => [],
  };
  const service = new ClusterContentsService({
    monitoring: { clustersOf: async () => [koalas, mine], ownsCluster: owns, reach: async () => ({ metrics: metricsOf(prometheus) }) },
    deployments: async () => [
      { id: 'd1', name: 'shop', namespace: 'shop', clusterId: 'machine-koala', ownerId: 'me', status: 'running' },
      { id: 'd2', name: 'theirs', namespace: 'theirs', clusterId: 'machine-koala', ownerId: 'you', status: 'running' },
    ] as DeploymentMetadata[],
    kubectl: async (cluster, args) => {
      if (!answers(cluster)) throw new Error('connection refused\nmore detail');
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
    const contents = await service.contents(asPerson('admin'), 'machine-koala');
    expect(contents.can).toEqual(['see-everything']);
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
    const contents = await service.contents(asPerson('me'), 'machine-koala');
    expect(contents.can).toEqual([]);
    expect(contents.workloads.map((workload) => workload.name)).toEqual(['shop']);
    expect(contents.services).toBeUndefined();
    expect(contents.nodes).toBeUndefined();
    expect(contents.releases).toBeUndefined();
  });

  it('reads a cluster once while the read is fresh, and lists what is broken across clusters', async () => {
    const { service, calls } = setUp(() => true);
    await service.contents(asPerson('admin'), 'machine-koala');
    await service.contents(asPerson('admin'), 'machine-koala');
    expect(calls.filter((call) => call.startsWith('get pods'))).toHaveLength(1);
    const broken = await service.broken(asPerson('admin'));
    expect(broken.workloads.map((workload) => [workload.clusterId, workload.name])).toEqual([['machine-koala', 'theirs-0'], ['c1', 'theirs-0']]);
    expect(broken.unread).toEqual([]);
  });

  it('names a cluster it could not read, rather than counting it as having nothing broken', async () => {
    const { service } = setUp(() => true, (cluster) => cluster.id !== 'c1');
    const broken = await service.broken(asPerson('admin'));
    expect(broken.workloads.map((workload) => workload.clusterId)).toEqual(['machine-koala']);
    expect(broken.unread).toEqual([{ clusterId: 'c1', clusterName: 'mine', problem: 'it does not answer (connection refused)' }]);
  });

  it('refuses a cluster the person cannot see', async () => {
    const { service } = setUp(() => true);
    await expect(service.contents(asPerson('me'), 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('reads nodes without GPUs too', () => {
    expect(nodesFrom(JSON.stringify({ items: [{ metadata: { name: 'n' }, status: { conditions: [{ type: 'Ready', status: 'False' }], capacity: { cpu: '500m' } } }] })))
      .toEqual([{ name: 'n', ready: false, roles: [], cpuCores: 0.5 }]);
  });
});

describe('what is on a cluster when part of it cannot be read', () => {
  const failing = (what: { helm?: boolean; nodes?: boolean }) => new ClusterContentsService({
    monitoring: { clustersOf: async () => [koalas], ownsCluster: (viewer) => viewer.id === 'admin', reach: async () => ({}) },
    deployments: async () => [],
    kubectl: async (_cluster, args) => {
      if (args[1] === 'nodes' && what.nodes) throw new Error('nodes is forbidden: User cannot list resource "nodes"\nmore detail');
      return args[1] === 'pods' ? podsJson : args[1] === 'namespaces' ? namespacesJson : nodesJson;
    },
    helm: async () => {
      if (what.helm) throw new Error('Kubernetes cluster unreachable: the server has asked for the client to provide credentials\nmore');
      return '[]';
    },
    labelOf: (id) => id,
    now: () => NOW,
  });

  it('tells its owner why Helm could not list the releases, in Helm\'s own words, instead of showing none, and still shows the workloads', async () => {
    const contents = await failing({ helm: true }).contents(asPerson('admin'), 'machine-koala');
    expect(contents.releases).toBeUndefined();
    expect(contents.releasesProblem).toBe('Helm could not list the releases: Kubernetes cluster unreachable: the server has asked for the client to provide credentials');
    expect(contents.workloads.length).toBeGreaterThan(0);
    expect(contents.nodes).toHaveLength(1);
    expect(contents.nodesProblem).toBeUndefined();
  });

  it('tells its owner why the nodes could not be listed, instead of showing none', async () => {
    const contents = await failing({ nodes: true }).contents(asPerson('admin'), 'machine-koala');
    expect(contents.nodes).toBeUndefined();
    expect(contents.nodesProblem).toBe('the nodes could not be listed: nodes is forbidden: User cannot list resource "nodes"');
    expect(contents.releases).toEqual([]);
    expect(contents.releasesProblem).toBeUndefined();
  });

  it('tells anyone but the owner neither, since they see no releases or nodes at all', async () => {
    const contents = await failing({ helm: true, nodes: true }).contents(asPerson('someone'), 'machine-koala');
    expect(contents).not.toHaveProperty('releasesProblem');
    expect(contents).not.toHaveProperty('nodesProblem');
    expect(contents).not.toHaveProperty('releases');
  });
});
