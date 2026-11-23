import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { runClusterJob, waitUntilRolledOut, type NamespacedCluster } from './cluster-jobs.js';

const kubectlSaid = (stderr: string) => Object.assign(new Error(stderr), { name: 'ClusterCommandFailed', result: { code: 1, stdout: '', stderr } });
const refused = 'The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?';
const gone = 'Error from server (NotFound): namespaces "app-1" not found';
const job = { name: 'fetch', namespace: 'app-1', manifest: { kind: 'Job', metadata: {} } };

describe('a cluster that cannot be asked while Koala waits on it', () => {
  it('keeps waiting on a rollout while the cluster cannot be reached, and ends once it has rolled out', async () => {
    const cluster = mock<NamespacedCluster>();
    cluster.kubectl
      .mockRejectedValueOnce(kubectlSaid(refused))
      .mockResolvedValueOnce(listed([webui(2, { replicas: 1, updatedReplicas: 1, availableReplicas: 1 }), set, pod({ ready: true, state: { running: {} } })]));
    await waitUntilRolledOut(cluster, 'deployment/open-webui', { beat: () => undefined, pollMs: 0 });
    expect(cluster.kubectl).toHaveBeenCalledTimes(2);
  });

  it('ends the rollout wait for good, saying why, once the cluster says what it waits on is gone', async () => {
    const cluster = mock<NamespacedCluster>();
    cluster.kubectl
      .mockRejectedValueOnce(kubectlSaid(gone))
      .mockResolvedValueOnce(listed([webui(2, { replicas: 1, updatedReplicas: 1, availableReplicas: 1 }), set, pod({ ready: true, state: { running: {} } })]));
    const ended = waitUntilRolledOut(cluster, 'deployment/open-webui', { beat: () => undefined, pollMs: 0 });
    await expect(ended).rejects.toMatchObject({ nonRetryable: true, message: `the rollout of deployment/open-webui cannot be asked: ${gone}` });
  });

  it('keeps waiting on a Job while its pods cannot be read, and ends once it succeeded', async () => {
    const cluster = mock<NamespacedCluster>();
    cluster.kubectl
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('|')
      .mockRejectedValueOnce(kubectlSaid(refused))
      .mockResolvedValueOnce('1|');
    await runClusterJob(cluster, job, { beat: () => undefined, pollMs: 0 });
    expect(cluster.kubectl).toHaveBeenCalledTimes(4);
  });

  it('ends the Job wait for good, saying why, once the cluster says its namespace is gone', async () => {
    const cluster = mock<NamespacedCluster>();
    cluster.kubectl
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('|')
      .mockRejectedValueOnce(kubectlSaid(gone))
      .mockResolvedValueOnce('1|');
    const ended = runClusterJob(cluster, job, { beat: () => undefined, pollMs: 0 });
    await expect(ended).rejects.toMatchObject({ nonRetryable: true, message: `the job fetch in app-1 cannot be asked: ${gone}` });
  });
});

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
