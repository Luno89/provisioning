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
        pod('nowrinkles', 'instance-backend-abc-1', { kind: 'ReplicaSet', name: 'instance-backend-abc' }, running(), { labels: { 'pod-template-hash': 'abc' } }),
        pod('searxng', 'searxng-1', undefined, running()),
        pod('crawl4ai', 'crawl4ai-1', undefined, running()),
        pod('shop', 'web', undefined, running()),
      ],
      namespaces: [ns('other-thing'), ns('monitoring'), ns('koala-run-tree-t1', { 'koala.dev/run': 'tree-t1', 'koala.dev/owner': 'me' }), ns('nowrinkles'), ns('searxng'), ns('crawl4ai'), ns('shop')],
    }, { ...owner, koalaNamespace: 'nowrinkles' }, NOW);
    expect(workloads.map((workload) => [workload.group, workload.namespace])).toEqual([
      ['apps', 'shop'], ['koala', 'koala-run-tree-t1'], ['platform', 'crawl4ai'], ['platform', 'monitoring'], ['platform', 'nowrinkles'], ['platform', 'searxng'], ['other', 'other-thing'],
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

describe('each way a pod is judged, the whole verdict', () => {
  const judged = (status: NonNullable<PodJson['status']>, created = OLD) => podVerdict(pod('a', 'p', undefined, status, { created }), NOW);
  const healthy = { ready: true, restarts: 0, failed: false, succeeded: false };
  const container = (fields: Record<string, unknown>) => ({ name: 'main', ready: false, restartCount: 0, ...fields });

  it('is ok and ready when running with every container ready, and not ready when one is not', () => {
    expect(judged({ phase: 'Running', containerStatuses: [container({ ready: true, state: { running: {} } }), container({ name: 'side', ready: true, state: { running: {} } })] })).toEqual({ ...healthy, state: 'ok' });
    expect(judged({ phase: 'Running', containerStatuses: [container({ ready: true, state: { running: {} } }), container({ name: 'side', state: { running: {} } })] }))
      .toEqual({ ...healthy, ready: false, state: 'warning', reason: 'it is running but not ready' });
    expect(judged({ phase: 'Running', containerStatuses: [] })).toEqual({ ...healthy, ready: false, state: 'warning', reason: 'it is running but not ready' });
  });

  it('is starting, not a warning, while it is young and not ready yet, until two minutes have passed', () => {
    const notReady = { phase: 'Running', containerStatuses: [container({ state: { running: {} } })] };
    expect(judged(notReady, minutesAgo(1))).toEqual({ ...healthy, ready: false, state: 'starting', reason: 'it is starting' });
    expect(judged(notReady, minutesAgo(2))).toEqual({ ...healthy, ready: false, state: 'warning', reason: 'it is running but not ready' });
    expect(judged({ phase: 'Pending' }, minutesAgo(2))).toEqual({ ...healthy, ready: false, state: 'warning', reason: 'it has been starting for a while' });
  });

  it('counts the restarts of every container, init containers too', () => {
    expect(judged({ phase: 'Running', initContainerStatuses: [container({ restartCount: 3, state: { terminated: { reason: 'Completed' } } })], containerStatuses: [container({ ready: true, restartCount: 2, state: { running: {} } })] }).restarts).toBe(5);
  });

  it('is done and ok when it ran to its end, and down with why when it failed', () => {
    expect(judged({ phase: 'Succeeded' })).toEqual({ ...healthy, ready: false, succeeded: true, state: 'ok' });
    expect(judged({ phase: 'Failed', containerStatuses: [container({ state: { terminated: { reason: 'OOMKilled' } } })] })).toEqual({ ...healthy, ready: false, failed: true, state: 'down', reason: 'it ran out of memory' });
    expect(judged({ phase: 'Failed', containerStatuses: [container({ state: { terminated: { reason: 'Completed' } } }), container({ name: 'side', state: { terminated: { reason: 'ContainerCannotRun' } } })] }))
      .toEqual({ ...healthy, ready: false, failed: true, state: 'down', reason: 'ContainerCannotRun' });
    expect(judged({ phase: 'Failed', reason: 'Evicted', containerStatuses: [container({ state: { terminated: { reason: 'Unknown' } } })] })).toEqual({ ...healthy, ready: false, failed: true, state: 'down', reason: 'Evicted' });
    expect(judged({ phase: 'Failed' })).toEqual({ ...healthy, ready: false, failed: true, state: 'down', reason: 'it stopped' });
  });

  it('is down, in plain words, for each way a container can be stuck, naming a crash loop\'s last exit only when it knows it', () => {
    const stuck = (reason: string, lastState?: Record<string, unknown>) => judged({ phase: 'Running', containerStatuses: [container({ state: { waiting: { reason } }, ...(lastState ? { lastState } : {}) })] });
    const down = (reason: string) => ({ ...healthy, ready: false, state: 'down', reason });
    expect(stuck('CrashLoopBackOff')).toEqual(down('it keeps crashing'));
    expect(stuck('CrashLoopBackOff', { terminated: { reason: 'Error' } })).toEqual(down('it keeps crashing: it exited with an error'));
    expect(stuck('CrashLoopBackOff', { terminated: { reason: 'Signal' } })).toEqual(down('it keeps crashing'));
    expect(stuck('ImagePullBackOff', { terminated: { reason: 'OOMKilled' } })).toEqual(down('its image cannot be pulled'));
    expect(stuck('ErrImagePull')).toEqual(down('its image cannot be pulled'));
    expect(stuck('InvalidImageName')).toEqual(down('its image name is not valid'));
    expect(stuck('CreateContainerConfigError')).toEqual(down('its container settings are wrong, such as a secret or config map it needs that is missing'));
    expect(stuck('CreateContainerError')).toEqual(down('its container cannot be created'));
    expect(stuck('ContainerCreating')).toEqual({ ...healthy, ready: false, state: 'warning', reason: 'it is running but not ready' });
  });

  it('waits for room on a node without a message when the scheduler gave none, and is starting before that while young', () => {
    const unscheduled = { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False' }] };
    expect(judged(unscheduled)).toEqual({ ...healthy, ready: false, state: 'warning', reason: 'it waits for room on a node' });
    expect(judged(unscheduled, minutesAgo(1))).toEqual({ ...healthy, ready: false, state: 'starting', reason: 'it is starting' });
    expect(judged({ phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'True' }] })).toEqual({ ...healthy, ready: false, state: 'warning', reason: 'it has been starting for a while' });
  });

  it('warns of a restart within the hour, by its exit when known, and forgets it after the hour', () => {
    const restarted = (lastState: Record<string, unknown>) => judged({ phase: 'Running', containerStatuses: [container({ ready: true, restartCount: 1, state: { running: {} }, lastState })] });
    const warned = (reason: string) => ({ ...healthy, restarts: 1, state: 'warning', reason });
    expect(restarted({ terminated: { finishedAt: minutesAgo(59) } })).toEqual(warned('it restarted in the last hour'));
    expect(restarted({ terminated: { reason: 'Signal', finishedAt: minutesAgo(5) } })).toEqual(warned('it restarted in the last hour: Signal'));
    expect(restarted({ terminated: { reason: 'Error', finishedAt: minutesAgo(5) } })).toEqual(warned('it restarted in the last hour: it exited with an error'));
    expect(restarted({ terminated: { reason: 'Error', finishedAt: minutesAgo(60) } })).toEqual({ ...healthy, restarts: 1, state: 'ok' });
    expect(restarted({ terminated: { reason: 'Error' } })).toEqual({ ...healthy, restarts: 1, state: 'ok' });
  });
});
