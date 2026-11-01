import { describe, expect, it } from 'vitest';
import { rolloutOf } from './self-upgrade.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const deployment = (name: string, revision: string, status: Record<string, number>, replicas = 1) =>
  ({ kind: 'Deployment', metadata: { name, generation: 2, annotations: { 'deployment.kubernetes.io/revision': revision } }, spec: { replicas }, status: { observedGeneration: 2, ...status } });
const replicaSet = (name: string, owner: string, revision: string) =>
  ({ kind: 'ReplicaSet', metadata: { name, annotations: { 'deployment.kubernetes.io/revision': revision }, ownerReferences: [{ kind: 'Deployment', name: owner }] } });
const pod = (name: string, owner: { kind: string; name: string }, container: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ kind: 'Pod', metadata: { name, ownerReferences: [owner], ...extra }, status: { phase: 'Running', containerStatuses: [{ name: 'c', ...container }] } });
const ready = { ready: true, state: { running: {} } };
const pulling = { ready: false, state: { waiting: { reason: 'ImagePullBackOff' } } };

describe('how far an instance\'s upgrade has rolled out', () => {
  it('is done once every workload runs its new spec on all its replicas and the old pods are gone', () => {
    const listed = { items: [
      deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 1, availableReplicas: 1 }),
      replicaSet('backend-new', 'instance-backend', '3'),
      pod('backend-new-a', { kind: 'ReplicaSet', name: 'backend-new' }, ready),
      { kind: 'StatefulSet', metadata: { name: 'instance-mongo', generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, currentRevision: 'm1', updateRevision: 'm1', readyReplicas: 1 } },
    ] };
    expect(rolloutOf(listed, NOW)).toEqual({ state: 'done' });
  });

  it('waits while a deployment has not updated, is not yet available, or still runs an old pod', () => {
    expect(rolloutOf({ items: [deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 0, availableReplicas: 1 })] }, NOW)).toEqual({ state: 'rolling', waiting: 'deployment/instance-backend has 0 of 1 updated' });
    expect(rolloutOf({ items: [deployment('instance-backend', '3', { replicas: 2, updatedReplicas: 1, availableReplicas: 1 })] }, NOW)).toEqual({ state: 'rolling', waiting: 'deployment/instance-backend still runs its old pods' });
    expect(rolloutOf({ items: [{ ...deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 1, availableReplicas: 1 }), status: { observedGeneration: 1 } }] }, NOW)).toEqual({ state: 'rolling', waiting: 'deployment/instance-backend has not seen its new spec' });
  });

  it('waits while a statefulset rolls to its new revision', () => {
    const sts = { kind: 'StatefulSet', metadata: { name: 'instance-mongo', generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: 2, currentRevision: 'm1', updateRevision: 'm2', readyReplicas: 1 } };
    expect(rolloutOf({ items: [sts] }, NOW)).toEqual({ state: 'rolling', waiting: 'statefulset/instance-mongo is rolling out' });
  });

  it('cannot finish once a pod of the new revision is in a state that does not recover', () => {
    const listed = { items: [
      deployment('instance-backend', '3', { replicas: 1, updatedReplicas: 1, availableReplicas: 0 }),
      replicaSet('backend-new', 'instance-backend', '3'),
      pod('backend-new-a', { kind: 'ReplicaSet', name: 'backend-new' }, pulling),
    ] };
    expect(rolloutOf(listed, NOW)).toEqual({ state: 'hopeless', reason: 'backend-new-a: ImagePullBackOff' });
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
    expect(rolloutOf(listed, NOW)).toEqual({ state: 'done' });
  });

  it('judges no pod while a workload has not seen its spec, so a rollback is not taken for the revision it undoes', () => {
    const undoing = (observedGeneration: number) => ({ items: [
      { ...deployment('instance-temporal', '7', { replicas: 1, updatedReplicas: 0, availableReplicas: 0 }), metadata: { name: 'instance-temporal', generation: 9, annotations: { 'deployment.kubernetes.io/revision': '7' } }, status: { observedGeneration, replicas: 1, updatedReplicas: 1, availableReplicas: 1 } },
      replicaSet('temporal-broken', 'instance-temporal', '7'),
      pod('temporal-broken-a', { kind: 'ReplicaSet', name: 'temporal-broken' }, pulling),
    ] });
    expect(rolloutOf(undoing(8), NOW)).toEqual({ state: 'rolling', waiting: 'deployment/instance-temporal has not seen its new spec' });
    expect(rolloutOf(undoing(9), NOW)).toEqual({ state: 'hopeless', reason: 'temporal-broken-a: ImagePullBackOff' });
  });

  it('waits while none of the release\'s workloads exists yet', () => {
    expect(rolloutOf({ items: [] }, NOW)).toEqual({ state: 'rolling', waiting: 'none of the release\'s workloads is there yet' });
  });
});
