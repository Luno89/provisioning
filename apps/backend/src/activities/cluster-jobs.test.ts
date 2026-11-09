import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { waitUntilRolledOut, type NamespacedCluster } from './cluster-jobs.js';

const webui = (generation: number, status: Record<string, number>) => ({ kind: 'Deployment', metadata: { name: 'open-webui', generation, annotations: { 'deployment.kubernetes.io/revision': '2' } }, spec: { replicas: 1 }, status: { observedGeneration: 2, ...status } });
const other = { kind: 'Deployment', metadata: { name: 'pipelines', generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, updatedReplicas: 0, availableReplicas: 0 } };
const set = { kind: 'ReplicaSet', metadata: { name: 'open-webui-2', annotations: { 'deployment.kubernetes.io/revision': '2' }, ownerReferences: [{ kind: 'Deployment', name: 'open-webui' }] } };
const pod = (state: Record<string, unknown>) => ({ kind: 'Pod', metadata: { name: 'open-webui-2-a', ownerReferences: [{ kind: 'ReplicaSet', name: 'open-webui-2' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'c', ...state }] } });
const listed = (items: unknown[]) => JSON.stringify({ items });

describe('waiting for one workload to roll out', () => {
  it('waits while its new spec is not yet seen, and ends once it has rolled out, whatever another workload in the namespace does', async () => {
    const cluster = mock<NamespacedCluster>();
    cluster.kubectl
      .mockResolvedValueOnce(listed([webui(3, { replicas: 1, updatedReplicas: 1, availableReplicas: 1 }), set, pod({ ready: true, state: { running: {} } }), other]))
      .mockResolvedValueOnce(listed([webui(2, { replicas: 1, updatedReplicas: 1, availableReplicas: 1 }), set, pod({ ready: true, state: { running: {} } }), other]));
    const beats: unknown[] = [];
    await waitUntilRolledOut(cluster, 'deployment/open-webui', { beat: (detail) => beats.push(detail), pollMs: 0 });
    expect(beats).toEqual(['deployment/open-webui', 'deployment/open-webui']);
    expect(cluster.kubectl).toHaveBeenCalledWith(['get', 'deployments,statefulsets,daemonsets,replicasets,jobs,pods', '-o', 'json']);
  });

  it('fails for good, saying why, once its new pods are in a state that does not recover', async () => {
    const cluster = mock<NamespacedCluster>();
    cluster.kubectl.mockResolvedValue(listed([webui(2, { replicas: 1, updatedReplicas: 1, availableReplicas: 0 }), set, pod({ ready: false, state: { waiting: { reason: 'ImagePullBackOff' } } })]));
    await expect(waitUntilRolledOut(cluster, 'deployment/open-webui', { beat: () => undefined, pollMs: 0 })).rejects.toThrow('deployment/open-webui cannot become ready: open-webui-2-a: ImagePullBackOff');
  });
});
