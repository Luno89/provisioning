import { describe, expect, it } from 'vitest';
import { brokenWorkloads, clusterWorkloads, podVerdict, type NamespaceJson, type PodJson, type WorkloadScope } from './cluster-workloads.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const OLD = '2026-10-01T00:00:00Z';
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const running = (ready = true) => ({ phase: 'Running', containerStatuses: [{ name: 'main', ready, restartCount: 0, state: { running: {} } }] });

function pod(namespace: string, name: string, owner: { kind: string; name: string } | undefined, status: NonNullable<PodJson['status']>, extra: { labels?: Record<string, string>; created?: string } = {}): PodJson {
  return {
    metadata: {
      name,
      namespace,
      creationTimestamp: extra.created ?? OLD,
      labels: extra.labels ?? {},
      ...(owner ? { ownerReferences: [{ ...owner, controller: true }] } : {}),
    },
    status,
  };
}

const ns = (name: string, labels: Record<string, string> = {}): NamespaceJson => ({ metadata: { name, labels } });

const owner: WorkloadScope = { ownsCluster: true, viewerLabel: 'me', apps: [{ id: 'd1', name: 'Shop', namespace: 'shop', mine: true }] };

describe('a pod, judged', () => {
  it('names what is wrong in plain words', () => {
    expect(podVerdict(pod('a', 'p', undefined, { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'OOMKilled', finishedAt: minutesAgo(1) } } }] }), NOW))
      .toMatchObject({ state: 'down', reason: 'it keeps crashing: it ran out of memory', restarts: 7 });
    expect(podVerdict(pod('a', 'p', undefined, { phase: 'Pending', containerStatuses: [{ ready: false, state: { waiting: { reason: 'ImagePullBackOff' } } }] }), NOW))
      .toMatchObject({ state: 'down', reason: 'its image cannot be pulled' });
    expect(podVerdict(pod('a', 'p', undefined, { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', message: '0/1 nodes are available: Insufficient memory.' }] }), NOW))
      .toMatchObject({ state: 'warning', reason: 'it waits for room on a node: 0/1 nodes are available: Insufficient memory.' });
    expect(podVerdict(pod('a', 'p', undefined, { phase: 'Pending' }, { created: minutesAgo(1) }), NOW)).toMatchObject({ state: 'starting' });
    expect(podVerdict(pod('a', 'p', undefined, { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 2, state: { running: {} }, lastState: { terminated: { reason: 'OOMKilled', finishedAt: minutesAgo(20) } } }] }), NOW))
      .toMatchObject({ state: 'warning', reason: 'it restarted in the last hour: it ran out of memory' });
    expect(podVerdict(pod('a', 'p', undefined, { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 2, state: { running: {} }, lastState: { terminated: { reason: 'OOMKilled', finishedAt: minutesAgo(200) } } }] }), NOW))
      .toMatchObject({ state: 'ok', restarts: 2 });
    expect(podVerdict(pod('a', 'p', undefined, { phase: 'Failed', reason: 'DeadlineExceeded', message: 'Pod was active on the node longer than the specified deadline' }), NOW))
      .toMatchObject({ state: 'down', failed: true, reason: 'Pod was active on the node longer than the specified deadline' });
  });
});

describe('the workloads on a cluster', () => {
  it('names a Deployment back from its ReplicaSet and counts its pods', () => {
    const hash = { 'pod-template-hash': '5d48d85d6' };
    const { workloads } = clusterWorkloads({
      pods: [
        pod('shop', 'shop-web-5d48d85d6-aaaaa', { kind: 'ReplicaSet', name: 'shop-web-5d48d85d6' }, running(), { labels: hash }),
        pod('shop', 'shop-web-5d48d85d6-bbbbb', { kind: 'ReplicaSet', name: 'shop-web-5d48d85d6' }, running(false), { labels: hash }),
      ],
      namespaces: [ns('shop')],
    }, owner, NOW);
    expect(workloads).toHaveLength(1);
    expect(workloads[0]).toMatchObject({ kind: 'Deployment', name: 'shop-web', pods: { total: 2, ready: 1 }, state: 'warning', group: 'apps', about: { kind: 'app', id: 'd1', name: 'Shop', mine: true } });
  });

  it('keeps a deployment healthy when only a replaced pod failed, and says so', () => {
    const { workloads } = clusterWorkloads({
      pods: [
        pod('tabby', 'tabby-1', { kind: 'ReplicaSet', name: 'tabby-x' }, running()),
        pod('tabby', 'tabby-2', { kind: 'ReplicaSet', name: 'tabby-x' }, { phase: 'Failed', reason: 'UnexpectedAdmissionError', message: 'Pod was rejected: no healthy devices' }),
      ],
      namespaces: [ns('tabby')],
    }, owner, NOW);
    expect(workloads[0]).toMatchObject({ state: 'ok', reasons: ['1 old pod failed and was replaced: Pod was rejected: no healthy devices'], pods: { total: 1, ready: 1 } });
  });

  it('leaves out finished jobs, and calls a failed one down', () => {
    const result = clusterWorkloads({
      pods: [
        pod('pipeline-builds', 'build-1-x', { kind: 'Job', name: 'build-1' }, { phase: 'Succeeded' }),
        pod('pipeline-builds', 'build-2-x', { kind: 'Job', name: 'build-2' }, { phase: 'Failed', containerStatuses: [{ state: { terminated: { reason: 'Error', exitCode: 1 } } }] }),
      ],
      namespaces: [ns('pipeline-builds')],
    }, owner, NOW);
    expect(result.finishedJobs).toBe(1);
    expect(result.workloads).toEqual([expect.objectContaining({ kind: 'Job', name: 'build-2', state: 'down', reasons: ['its job failed: it exited with an error'], group: 'koala', about: { kind: 'builds' } })]);
  });

  it('groups by who it belongs to: apps, Koala\'s work, the platform, the rest', () => {
    const { workloads } = clusterWorkloads({
      pods: [
        pod('other-thing', 'x', undefined, running()),
        pod('monitoring', 'prom-0', { kind: 'StatefulSet', name: 'prom' }, running(), { labels: { 'app.kubernetes.io/instance': 'kube-prometheus-stack' } }),
        pod('koala-run-tree-t1', 'workspace', undefined, running()),
        pod('default', 'provisioning-worker-abc-1', { kind: 'ReplicaSet', name: 'provisioning-worker-abc' }, running(), { labels: { 'pod-template-hash': 'abc' } }),
        pod('shop', 'web', undefined, running()),
      ],
      namespaces: [ns('other-thing'), ns('monitoring'), ns('koala-run-tree-t1', { 'koala.dev/run': 'tree-t1', 'koala.dev/owner': 'me' }), ns('default'), ns('shop')],
    }, owner, NOW);
    expect(workloads.map((workload) => [workload.group, workload.namespace])).toEqual([
      ['apps', 'shop'], ['koala', 'koala-run-tree-t1'], ['platform', 'default'], ['platform', 'monitoring'], ['other', 'other-thing'],
    ]);
    expect(workloads[1]!.about).toEqual({ kind: 'tree', id: 't1', mine: true });
    expect(workloads.find((workload) => workload.namespace === 'monitoring')!.release).toBe('kube-prometheus-stack');
  });

  it('shows someone who does not own the cluster only their own namespaces', () => {
    const guest: WorkloadScope = { ownsCluster: false, viewerLabel: 'me', apps: [{ id: 'd1', name: 'Shop', namespace: 'shop', mine: true }, { id: 'd2', name: 'Theirs', namespace: 'theirs', mine: false }] };
    const { workloads } = clusterWorkloads({
      pods: [pod('shop', 'a', undefined, running()), pod('theirs', 'b', undefined, running()), pod('monitoring', 'c', undefined, running()), pod('ws-mine', 'd', undefined, running()), pod('ws-other', 'e', undefined, running())],
      namespaces: [ns('shop'), ns('theirs'), ns('monitoring'), ns('ws-mine', { 'koala.dev/owner': 'me', 'koala.dev/run': 'r1' }), ns('ws-other', { 'koala.dev/owner': 'you', 'koala.dev/run': 'r2' })],
    }, guest, NOW);
    expect(workloads.map((workload) => workload.namespace)).toEqual(['shop', 'ws-mine']);
  });

  it('adds memory and CPU when they are measured, and says when they are not', () => {
    const input = { pods: [pod('shop', 'a', { kind: 'StatefulSet', name: 'db' }, running()), pod('shop', 'b', { kind: 'StatefulSet', name: 'db' }, running())], namespaces: [ns('shop')] };
    const measured = clusterWorkloads({ ...input, memory: [{ namespace: 'shop', pod: 'a', value: 100 }, { namespace: 'shop', pod: 'b', value: 50 }], cpu: [{ namespace: 'shop', pod: 'a', value: 0.25 }] }, owner, NOW);
    expect(measured.measured).toBe(true);
    expect(measured.workloads[0]).toMatchObject({ memoryBytes: 150, cpuCores: 0.25 });
    const unmeasured = clusterWorkloads(input, owner, NOW);
    expect(unmeasured.measured).toBe(false);
    expect(unmeasured.workloads[0]!.memoryBytes).toBeUndefined();
  });

  it('picks out the broken ones', () => {
    const { workloads } = clusterWorkloads({
      pods: [pod('shop', 'a', undefined, running()), pod('shop', 'b', undefined, { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ErrImagePull' } } }] })],
      namespaces: [ns('shop')],
    }, owner, NOW);
    expect(brokenWorkloads(workloads).map((workload) => workload.name)).toEqual(['b']);
  });
});
