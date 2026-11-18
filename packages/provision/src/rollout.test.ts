import { describe, expect, it } from 'vitest';
import { releaseRollout, rolloutAcross, rolloutOf, SETUP_LABEL, stuckHook } from './rollout.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const deployment = (name: string, revision: string, status: Record<string, number>, replicas = 1) =>
  ({ kind: 'Deployment', metadata: { name, generation: 2, annotations: { 'deployment.kubernetes.io/revision': revision } }, spec: { replicas }, status: { observedGeneration: 2, ...status } });
const replicaSet = (name: string, owner: string, revision: string) =>
  ({ kind: 'ReplicaSet', metadata: { name, annotations: { 'deployment.kubernetes.io/revision': revision }, ownerReferences: [{ kind: 'Deployment', name: owner }] } });
const pod = (name: string, owner: { kind: string; name: string }, container: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ kind: 'Pod', metadata: { name, ownerReferences: [owner], ...extra }, status: { phase: 'Running', containerStatuses: [{ name: 'c', ...container }] } });
const ready = { ready: true, state: { running: {} } };
const pulling = { ready: false, state: { waiting: { reason: 'ImagePullBackOff' } } };

describe('how far a rollout has got', () => {
  it('is done once every workload runs its new spec on all its replicas and the old pods are gone', () => {
    const listed = { items: [
      deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 1, availableReplicas: 1 }),
      replicaSet('backend-new', 'instance-backend', '3'),
      pod('backend-new-a', { kind: 'ReplicaSet', name: 'backend-new' }, ready),
      { kind: 'StatefulSet', metadata: { name: 'instance-mongo', generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, currentRevision: 'm1', updateRevision: 'm1', readyReplicas: 1 } },
    ] };
    expect(rolloutOf(listed, { now: NOW })).toEqual({ state: 'done' });
  });

  it('waits while a deployment has not updated, is not yet available, or still runs an old pod', () => {
    expect(rolloutOf({ items: [deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 0, availableReplicas: 1 })] }, { now: NOW })).toEqual({ state: 'rolling', waiting: 'deployment/instance-backend has 0 of 1 updated' });
    expect(rolloutOf({ items: [deployment('instance-backend', '3', { replicas: 2, updatedReplicas: 1, availableReplicas: 1 })] }, { now: NOW })).toEqual({ state: 'rolling', waiting: 'deployment/instance-backend still runs its old pods' });
    expect(rolloutOf({ items: [{ ...deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 1, availableReplicas: 1 }), status: { observedGeneration: 1 } }] }, { now: NOW })).toEqual({ state: 'rolling', waiting: 'deployment/instance-backend has not seen its new spec' });
  });

  it('waits while a statefulset rolls to its new revision', () => {
    const sts = { kind: 'StatefulSet', metadata: { name: 'instance-mongo', generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: 2, currentRevision: 'm1', updateRevision: 'm2', readyReplicas: 1 } };
    expect(rolloutOf({ items: [sts] }, { now: NOW })).toEqual({ state: 'rolling', waiting: 'statefulset/instance-mongo is rolling out' });
  });

  it('cannot finish once a pod of the new revision is in a state that does not recover', () => {
    const listed = { items: [
      deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 1, availableReplicas: 0 }),
      replicaSet('backend-new', 'instance-backend', '3'),
      pod('backend-new-a', { kind: 'ReplicaSet', name: 'backend-new' }, pulling),
    ] };
    expect(rolloutOf(listed, { now: NOW })).toEqual({ state: 'hopeless', reason: 'backend-new-a: ImagePullBackOff' });
  });

  it('judges only the current revision\'s pods, not the old one\'s, a terminating one, or a job\'s', () => {
    const listed = { items: [
      deployment('instance-backend', '4', { replicas: 1, updatedReplicas: 1, availableReplicas: 1 }),
      replicaSet('backend-bad', 'instance-backend', '3'),
      replicaSet('backend-back', 'instance-backend', '4'),
      pod('backend-bad-a', { kind: 'ReplicaSet', name: 'backend-bad' }, pulling),
      pod('backend-back-gone', { kind: 'ReplicaSet', name: 'backend-back' }, pulling, { deletionTimestamp: '2026-10-31T11:59:00Z' }),
      pod('backend-back-a', { kind: 'ReplicaSet', name: 'backend-back' }, ready),
      pod('self-upgrade-x', { kind: 'Job', name: 'instance-self-upgrade-1' }, pulling),
    ] };
    expect(rolloutOf(listed, { now: NOW })).toEqual({ state: 'done' });
  });

  it('judges no pod while a workload has not seen its spec, so a rollback is not taken for the revision it undoes', () => {
    const undoing = (observedGeneration: number) => ({ items: [
      { ...deployment('instance-temporal', '7', { replicas: 1, updatedReplicas: 0, availableReplicas: 0 }), metadata: { name: 'instance-temporal', generation: 9, annotations: { 'deployment.kubernetes.io/revision': '7' } }, status: { observedGeneration, replicas: 1, updatedReplicas: 1, availableReplicas: 1 } },
      replicaSet('temporal-broken', 'instance-temporal', '7'),
      pod('temporal-broken-a', { kind: 'ReplicaSet', name: 'temporal-broken' }, pulling),
    ] });
    expect(rolloutOf(undoing(8), { now: NOW })).toEqual({ state: 'rolling', waiting: 'deployment/instance-temporal has not seen its new spec' });
    expect(rolloutOf(undoing(9), { now: NOW })).toEqual({ state: 'hopeless', reason: 'temporal-broken-a: ImagePullBackOff' });
  });

  it('waits while none of its workloads exists yet, unless told an empty place has nothing to wait for', () => {
    expect(rolloutOf({ items: [] }, { now: NOW })).toEqual({ state: 'rolling', waiting: 'none of its workloads is there yet' });
    expect(rolloutOf({ items: [] }, { none: 'done', now: NOW })).toEqual({ state: 'done' });
  });

  it('waits while a daemonset has not updated or made available its pod on every node, and judges its pods', () => {
    const daemonSet = (status: Record<string, number>) => ({ kind: 'DaemonSet', metadata: { name: 'node-exporter', generation: 1 }, status: { observedGeneration: 1, desiredNumberScheduled: 2, ...status } });
    expect(rolloutOf({ items: [daemonSet({ updatedNumberScheduled: 1, numberAvailable: 1 })] }, { now: NOW })).toEqual({ state: 'rolling', waiting: 'daemonset/node-exporter has 1 of 2 updated' });
    expect(rolloutOf({ items: [daemonSet({ updatedNumberScheduled: 2, numberAvailable: 1 })] }, { now: NOW })).toEqual({ state: 'rolling', waiting: 'daemonset/node-exporter has 1 of 2 available' });
    expect(rolloutOf({ items: [daemonSet({ updatedNumberScheduled: 2, numberAvailable: 2 })] }, { now: NOW })).toEqual({ state: 'done' });
    expect(rolloutOf({ items: [daemonSet({ updatedNumberScheduled: 2, numberAvailable: 1 }), pod('node-exporter-a', { kind: 'DaemonSet', name: 'node-exporter' }, pulling)] }, { now: NOW })).toEqual({ state: 'hopeless', reason: 'node-exporter-a: ImagePullBackOff' });
  });

  it('cannot finish, saying why, when the cluster refuses to make a deployment\'s pods', () => {
    const refusal = { type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: 'pods "books-7c9d-x" is forbidden: exceeded quota: books, requested: limits.memory=2Gi' };
    const listed = { items: [
      deployment('books', '1', { replicas: 0, updatedReplicas: 0, availableReplicas: 0 }),
      { ...replicaSet('books-7c9d', 'books', '1'), status: { conditions: [refusal] } },
    ] };
    expect(rolloutOf(listed, { now: NOW })).toEqual({ state: 'hopeless', reason: 'books cannot make its pods: pods "books-7c9d-x" is forbidden: exceeded quota: books, requested: limits.memory=2Gi' });
    const onTheDeployment = { items: [{ ...deployment('books', '1', { replicas: 0, updatedReplicas: 0, availableReplicas: 0 }), status: { observedGeneration: 2, conditions: [refusal] } }] };
    expect(rolloutOf(onTheDeployment, { now: NOW }).state).toBe('hopeless');
    const settled = { items: [deployment('books', '1', { replicas: 1, updatedReplicas: 1, availableReplicas: 1 }), { ...replicaSet('books-7c9d', 'books', '1'), status: { conditions: [{ ...refusal, status: 'False' }] } }] };
    expect(rolloutOf(settled, { now: NOW })).toEqual({ state: 'done' });
  });

  it('says why a pod waits when the scheduler has found no room for it, which may still come', () => {
    const unplaced = { ...pod('backend-new-a', { kind: 'ReplicaSet', name: 'backend-new' }, {}), status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/1 nodes are available: 1 Insufficient memory.' }] } };
    const listed = { items: [deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 1, availableReplicas: 0 }), replicaSet('backend-new', 'instance-backend', '3'), unplaced] };
    expect(rolloutOf(listed, { now: NOW })).toEqual({ state: 'rolling', waiting: 'deployment/instance-backend has 0 of 1 available; backend-new-a waits for room: 0/1 nodes are available: 1 Insufficient memory.' });
  });

  it('across several places is hopeless if any is, rolling if any still is, and done once all are', () => {
    const done = { items: [deployment('a', '1', { replicas: 1, updatedReplicas: 1, availableReplicas: 1 })] };
    const rolling = { items: [deployment('b', '1', { replicas: 1, updatedReplicas: 0, availableReplicas: 0 })] };
    const hopeless = { items: [deployment('c', '1', { replicas: 1, updatedReplicas: 1, availableReplicas: 0 }), replicaSet('c-1', 'c', '1'), pod('c-1-a', { kind: 'ReplicaSet', name: 'c-1' }, pulling)] };
    expect(rolloutAcross([done, rolling, hopeless], { now: NOW }).state).toBe('hopeless');
    expect(rolloutAcross([done, rolling], { now: NOW })).toEqual({ state: 'rolling', waiting: 'deployment/b has 0 of 1 updated' });
    expect(rolloutAcross([done, { items: [] }], { none: 'done', now: NOW })).toEqual({ state: 'done' });
  });
});

describe('a chart\'s hook that can never finish', () => {
  const hook = (name: string, made: string) => ({ kind: 'Job', metadata: { name, creationTimestamp: made, annotations: { 'helm.sh/hook': 'pre-install' } } });
  const since = Date.parse('2026-10-31T11:00:00Z');

  it('is named once a pod of a hook made since the apply began is in a state that does not recover', () => {
    const listed = { items: [hook('admission-create', '2026-10-31T11:00:05Z'), pod('admission-create-x', { kind: 'Job', name: 'admission-create' }, pulling)] };
    expect(stuckHook(listed, since, NOW)).toBe('the chart\'s admission-create-x: ImagePullBackOff');
  });

  it('is not named for a hook still starting, an older hook, or a job that is no hook', () => {
    const starting = { ready: false, state: { waiting: { reason: 'ContainerCreating' } } };
    expect(stuckHook({ items: [hook('admission-create', '2026-10-31T11:00:05Z'), pod('a', { kind: 'Job', name: 'admission-create' }, starting)] }, since, NOW)).toBeUndefined();
    expect(stuckHook({ items: [hook('admission-create', '2026-10-31T10:00:00Z'), pod('a', { kind: 'Job', name: 'admission-create' }, pulling)] }, since, NOW)).toBeUndefined();
    expect(stuckHook({ items: [{ kind: 'Job', metadata: { name: 'backup', creationTimestamp: '2026-10-31T11:00:05Z' } }, pod('b', { kind: 'Job', name: 'backup' }, pulling)] }, since, NOW)).toBeUndefined();
  });
});

describe('how far a release of a chart has got, its setup Jobs included', () => {
  const job = (name: string, step: string, status: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    ({ kind: 'Job', metadata: { name, labels: { [SETUP_LABEL]: step }, ...extra }, status });
  const failedJob = (name: string, step: string, message: string, extra: Record<string, unknown> = {}) =>
    job(name, step, { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message }] }, extra);
  const running = { ready: false, state: { running: {} } };
  const backend = deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 1, availableReplicas: 1 });

  it('is done once every workload is rolled out and every setup Job it holds has succeeded', () => {
    const listed = { items: [backend, job('instance-seed-4', 'seed', { succeeded: 1 }), job('instance-platform-services-4', 'platform-services', { conditions: [{ type: 'Complete', status: 'True' }] })] };
    expect(releaseRollout(listed, { now: NOW })).toEqual({ state: 'done' });
  });

  it('names every workload and Job still waiting, each with what it waits on', () => {
    const listed = { items: [
      deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 1, availableReplicas: 0 }),
      { kind: 'StatefulSet', metadata: { name: 'instance-mongo-stores', generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, readyReplicas: 0 } },
      job('instance-platform-services-4', 'platform-services', { active: 1 }),
      pod('platform-services-x', { kind: 'Job', name: 'instance-platform-services-4' }, running),
      job('instance-seed-4', 'seed'),
    ] };
    expect(releaseRollout(listed, { now: NOW })).toEqual({ state: 'rolling', waiting: [
      'deployment/instance-backend has 0 of 1 available',
      'statefulset/instance-mongo-stores has 0 of 1 ready',
      'job/instance-platform-services-4 runs',
      'job/instance-seed-4 has not started',
    ] });
  });

  it('judges only the setup Jobs the release holds now, not one being removed with an earlier revision, nor the self-upgrade\'s', () => {
    const listed = { items: [
      backend,
      failedJob('instance-seed-3', 'seed', 'Job has reached the specified backoff limit', { deletionTimestamp: '2026-10-31T11:59:00Z' }),
      { kind: 'Job', metadata: { name: 'instance-self-upgrade-29000' }, status: { active: 1 } },
      job('instance-seed-4', 'seed', { succeeded: 1 }),
    ] };
    expect(releaseRollout(listed, { now: NOW })).toEqual({ state: 'done' });
  });

  it('cannot finish once a setup Job of the revision has failed, naming the Job and why', () => {
    const listed = { items: [backend, failedJob('instance-seed-4', 'seed', 'Job has reached the specified backoff limit')] };
    expect(releaseRollout(listed, { now: NOW })).toEqual({ state: 'hopeless', reason: 'job/instance-seed-4 failed: Job has reached the specified backoff limit', job: 'instance-seed-4' });
  });

  it('cannot finish once a setup Job\'s pod is in a state that does not recover, or a workload\'s is', () => {
    const pulled = { items: [backend, job('instance-seed-4', 'seed', { active: 1 }), pod('seed-x', { kind: 'Job', name: 'instance-seed-4' }, pulling)] };
    expect(releaseRollout(pulled, { now: NOW })).toEqual({ state: 'hopeless', reason: 'job/instance-seed-4: seed-x: ImagePullBackOff', job: 'instance-seed-4' });
    const workload = { items: [deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 1, availableReplicas: 0 }), replicaSet('backend-new', 'instance-backend', '3'), pod('backend-new-a', { kind: 'ReplicaSet', name: 'backend-new' }, pulling)] };
    expect(releaseRollout(workload, { now: NOW })).toEqual({ state: 'hopeless', reason: 'backend-new-a: ImagePullBackOff' });
  });

  it('says a Job waits for room when the scheduler has not placed its pod', () => {
    const unplaced = { ...pod('seed-x', { kind: 'Job', name: 'instance-seed-4' }, {}), status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', message: '0/1 nodes are available: 1 Insufficient cpu.' }] } };
    expect(releaseRollout({ items: [backend, job('instance-seed-4', 'seed', { active: 1 }), unplaced] }, { now: NOW }))
      .toEqual({ state: 'rolling', waiting: ['job/instance-seed-4 waits for room: 0/1 nodes are available: 1 Insufficient cpu.'] });
  });
});
