import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ClusterCommandFailed, ClusterUnreachable, type ClusterAccess, type InfisicalService, type InfrastructureService, type Reach } from '../infrastructure/index.js';
import type { GiteaService } from '../projects/index.js';
import { ODOO_PROJECT_APP } from '../releases/index.js';
import type { Followed } from '../platform/index.js';
import { CheckWorkloadActivity } from './CheckWorkloadActivity.js';
import { DestroyAppActivity } from './DestroyAppActivity.js';
import { ResizeDiskActivity } from './ResizeDiskActivity.js';
import { SyncConfigActivity } from './SyncConfigActivity.js';
import { VerifyGpuRuntimeActivity } from './VerifyGpuRuntimeActivity.js';
import { handedReach } from './handed-reach.js';
import { clusterActivities, type ClusterSetup } from '../worker-cluster.js';

const gitea = vi.hoisted(() => ({
  getRegistryHosts: vi.fn(),
  getRawFile: vi.fn(),
  createDeployToken: vi.fn(),
  revokeToken: vi.fn(),
}));

import { RunPipelineActivity } from './RunPipelineActivity.js';

const DESK: Reach = { clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1\nkind: Config\n' };
const KOALA: Reach = { clusterId: 'machine-dev1', kind: 'koala' };
const LOG = join(mkdtempSync(join(tmpdir(), 'cluster-steps-')), 'step.log');

let access: MockProxy<ClusterAccess>;
let infra: MockProxy<InfrastructureService>;
let said: Array<{ reach: Reach; args: readonly string[] }>;

const steps = () => ({ access, infra, gitea: gitea as unknown as GiteaService, infisical: mock<InfisicalService>(), database: { mongo: { uri: 'mongodb://unused', dbName: 'unused' }, dataKey: 'cluster-steps-test-key' }, machineMetricsUrl: { off: 'these tests deploy to no other machine' } });

beforeEach(() => {
  access = mock<ClusterAccess>();
  Object.defineProperty(access, 'here', { value: { root: false, koalaMachineId: 'koala' }, configurable: true });
  infra = mock<InfrastructureService>();
  said = [];
  access.kubeconfigOf.mockImplementation(async (target) => `/clusters/kubeconfig-${(target as Reach).kind}`);
  access.kubectl.mockImplementation(async (target, args) => {
    said.push({ reach: target as Reach, args });
    return args.includes('deployments,statefulsets,daemonsets,replicasets,jobs,pods') ? JSON.stringify({ items: [{ kind: 'Deployment', metadata: { name: 'open-webui', generation: 1 }, spec: { replicas: 0 }, status: { observedGeneration: 1 } }] }) : '';
  });
  access.helm.mockResolvedValue('');
  access.apply.mockResolvedValue('');
  infra.deploy.mockResolvedValue({ stdout: '', logFile: LOG });
  infra.destroy.mockResolvedValue({ stdout: '', logFile: LOG });
});

describe('the reach a cluster step works with', () => {
  it('is the one its workflow handed it', () => {
    expect(handedReach({ clusterId: 'machine-desk', reach: DESK })).toBe(DESK);
  });

  it('is the machine whose kubeconfig a step scheduled before this release carries', () => {
    expect(handedReach({ clusterId: 'machine-desk', kubeconfig: 'apiVersion: v1' })).toEqual({ clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1' });
  });

  it('is refused, never guessed, when nothing was handed', () => {
    expect(() => handedReach({ clusterId: 'machine-desk' })).toThrow('this step was handed no way to reach machine-desk');
  });
});

describe('checking a workload', () => {
  const listed = (items: unknown[]) => JSON.stringify({ items });
  const shop = { kind: 'Deployment', metadata: { name: 'shop', generation: 2, annotations: { 'deployment.kubernetes.io/revision': '2' } }, spec: { replicas: 1 }, status: { observedGeneration: 2, replicas: 1, updatedReplicas: 1, availableReplicas: 1 } };
  const set = (name: string, revision: string, extra: Record<string, unknown> = {}) => ({ kind: 'ReplicaSet', metadata: { name, annotations: { 'deployment.kubernetes.io/revision': revision }, ownerReferences: [{ kind: 'Deployment', name: 'shop' }] }, ...extra });
  const pod = (name: string, owner: string, ready: boolean) => ({ kind: 'Pod', metadata: { name, ownerReferences: [{ kind: 'ReplicaSet', name: owner }] }, status: { phase: 'Running', containerStatuses: [{ ready, restartCount: 0, state: { running: {} } }] } });

  it('reads the workloads of the app\'s namespace on the cluster it was handed, and is healthy once they have rolled out', async () => {
    access.kubectl.mockResolvedValueOnce(listed([shop, set('shop-2', '2'), pod('shop-2-a', 'shop-2', true)]));
    const read = await CheckWorkloadActivity({ name: 'shop', namespace: 'shop-1a2b3c', clusterId: 'machine-desk', reach: DESK }, { access });
    expect(read.health).toBe('healthy');
    expect(access.kubectl).toHaveBeenCalledWith(DESK, ['get', 'deployments,statefulsets,daemonsets,replicasets,jobs,pods', '-n', 'shop-1a2b3c', '-o', 'json']);
  });

  it('is still starting while the deployment has not seen its new spec, though the old pods are ready', async () => {
    access.kubectl.mockResolvedValueOnce(listed([{ ...shop, metadata: { ...shop.metadata, generation: 3 } }, set('shop-2', '2'), pod('shop-2-a', 'shop-2', true)]));
    const read = await CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk', reach: DESK }, { access });
    expect(read).toEqual({ health: 'starting', reason: 'deployment/shop has not seen its new spec' });
  });

  it('writes what the app waits on to its deploy log when it changes, and not again while it stays the same', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'waiting-')), 'deploy.log');
    const unseen = listed([{ ...shop, metadata: { ...shop.metadata, generation: 3 } }, set('shop-2', '2'), pod('shop-2-a', 'shop-2', true)]);
    access.kubectl.mockResolvedValue(unseen);
    const first = await CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk', reach: DESK, logFile: log }, { access });
    await CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk', reach: DESK, logFile: log, told: first.reason }, { access });
    expect(readFileSync(log, 'utf8')).toBe('[deploy] waiting: deployment/shop has not seen its new spec\n');
  });

  it('says when the cluster refuses to make the pods', async () => {
    access.kubectl.mockResolvedValueOnce(listed([{ ...shop, status: { observedGeneration: 2 } }, set('shop-2', '2', { status: { conditions: [{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: 'exceeded quota: koala' }] } })]));
    const read = await CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk', reach: DESK }, { access });
    expect(read.health).toBe('unhealthy');
    expect(read.reason).toContain('exceeded quota');
  });

  it('keeps waiting while the cluster does not answer yet, writing why to the deploy log once', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'unanswered-')), 'deploy.log');
    const refused = { code: 1, stdout: '', stderr: 'The connection to the server 100.64.0.7:6443 was refused - did you specify the right host or port?' };
    access.kubectl.mockRejectedValue(new ClusterCommandFailed('machine-desk', { command: 'kubectl', args: ['get'] }, refused));
    const first = await CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk', reach: DESK, logFile: log }, { access });
    expect(first.health).toBe('unknown');
    expect(first.reason).toMatch(/^the workload cannot be read yet: .*was refused/);
    await CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk', reach: DESK, logFile: log, told: first.reason }, { access });
    expect(readFileSync(log, 'utf8')).toBe(`[deploy] waiting: ${first.reason}\n`);
  });

  it('ends unhealthy, with why, when the workload can never be read', async () => {
    access.kubectl.mockRejectedValueOnce(new ClusterUnreachable('machine-desk', 'stopped', 'desk is stopped until something runs on it'));
    expect(await CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk', reach: DESK }, { access })).toEqual({ health: 'unhealthy', reason: 'the workload could not be read: desk is stopped until something runs on it' });
    access.kubectl.mockResolvedValueOnce('<html>not a list</html>');
    const garbled = await CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk', reach: DESK }, { access });
    expect(garbled.health).toBe('unhealthy');
    expect(garbled.reason).toMatch(/^the workload could not be read: .*JSON/);
  });

  it('fails at once when it was handed no way to reach the cluster', async () => {
    await expect(CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk' }, { access })).rejects.toThrow('handed no way to reach machine-desk');
    expect(access.kubectl).not.toHaveBeenCalled();
  });
});

describe('readying a machine\'s GPUs', () => {
  const nodes = (gpus: number) => JSON.stringify({ items: [{ status: { allocatable: { cpu: '16', 'nvidia.com/gpu': String(gpus) } } }] });
  const none = JSON.stringify({ items: [] });
  const plugin = (generation: number, seen: number, updated: number) => JSON.stringify({ kind: 'DaemonSet', metadata: { name: 'nvidia-device-plugin-daemonset', generation }, status: { observedGeneration: seen, desiredNumberScheduled: 1, updatedNumberScheduled: updated, numberAvailable: updated } });
  const pluginPod = JSON.stringify({ items: [{ kind: 'Pod', metadata: { name: 'nvidia-device-plugin-daemonset-x', ownerReferences: [{ kind: 'DaemonSet', name: 'nvidia-device-plugin-daemonset' }] }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] } }] });

  it('is not ready while the plugin it applied has not rolled out, even though the plugin from before still advertises the GPUs', async () => {
    access.apply.mockResolvedValue('');
    let reads = 0;
    access.kubectl.mockImplementation(async (_target, args) => {
      if (args[1] === 'nodes') return nodes(2);
      if (args[1] === 'daemonset') return (reads += 1) > 2 ? plugin(2, 2, 1) : plugin(2, 1, 0);
      if (args[1] === 'pods') return pluginPod;
      return none;
    });
    await VerifyGpuRuntimeActivity({ clusterId: 'machine-desk', reach: DESK, vendor: 'nvidia', count: 2, machine: 'desk' }, { access }, async () => undefined);
    expect(reads).toBe(3);
  });

  it('fails with what to do when k3s there has no NVIDIA runtime for the plugin', async () => {
    access.apply.mockResolvedValue('');
    access.kubectl.mockImplementation(async (_target, args) => {
      if (args[1] === 'nodes') return nodes(0);
      if (args[1] === 'daemonset') return plugin(1, 1, 0);
      if (args[1] === 'pods') return JSON.stringify({ items: [{ kind: 'Pod', metadata: { name: 'nvidia-device-plugin-daemonset-x' }, status: { phase: 'Pending' } }] });
      if (args[1] === 'events') return JSON.stringify({ items: [{ reason: 'FailedCreatePodSandBox', message: 'failed to get sandbox runtime: no runtime for "nvidia" is configured' }] });
      return none;
    });
    await expect(VerifyGpuRuntimeActivity({ clusterId: 'machine-desk', reach: DESK, vendor: 'nvidia', count: 1, machine: 'desk' }, { access }, async () => undefined))
      .rejects.toThrow(/^the NVIDIA device plugin cannot run on desk: failed to get sandbox runtime: no runtime for "nvidia" is configured\. Run the command from My Machines again on it, .*restart k3s there once it is installed, then deploy again\.$/);
  });

  it('applies the vendor\'s device plugin on the cluster it was handed and is ready once the node advertises what the app asks', async () => {
    const applied: string[] = [];
    access.apply.mockImplementation(async (target, manifest) => { said.push({ reach: target as Reach, args: ['apply'] }); applied.push(manifest); return ''; });
    let reads = 0;
    access.kubectl.mockImplementation(async (target, args) => {
      said.push({ reach: target as Reach, args });
      if (args[1] === 'nodes') return nodes((reads += 1) > 2 ? 2 : 0);
      if (args[1] === 'daemonset') return plugin(1, 1, 1);
      if (args[1] === 'pods') return pluginPod;
      return none;
    });
    const log = join(mkdtempSync(join(tmpdir(), 'koala-gpus-')), 'deploy.log');
    await VerifyGpuRuntimeActivity({ clusterId: 'machine-desk', reach: DESK, vendor: 'nvidia', count: 2, machine: 'desk', logFile: log }, { access }, async () => undefined);
    expect(readFileSync(log, 'utf8')).toContain('[gpus] desk advertises 2 NVIDIA GPUs to the scheduler');
    expect(applied[0]).toContain('nvidia-device-plugin-daemonset');
    expect(said.every((call) => call.reach === DESK)).toBe(true);
    expect(reads).toBe(3);
  });

  it('fails with what to do when the plugin\'s pod cannot keep running, and reads only the nodes, the plugin and its pods\' events', async () => {
    access.apply.mockResolvedValue('');
    const asked: string[] = [];
    access.kubectl.mockImplementation(async (_target, args) => {
      asked.push(args[1]!);
      if (args[1] === 'nodes') return nodes(0);
      if (args[1] === 'daemonset') return plugin(1, 1, 0);
      if (args[1] === 'pods') return JSON.stringify({ items: [{ kind: 'Pod', metadata: { name: 'nvidia-device-plugin-daemonset-x', ownerReferences: [{ kind: 'DaemonSet', name: 'nvidia-device-plugin-daemonset' }] }, status: { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 6, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off restarting failed container' } } }] } }] });
      return none;
    });
    await expect(VerifyGpuRuntimeActivity({ clusterId: 'machine-desk', reach: DESK, vendor: 'nvidia', count: 1, machine: 'desk' }, { access }, async () => undefined))
      .rejects.toThrow(/^the NVIDIA device plugin cannot run on desk: .*CrashLoopBackOff.*\. Run the command from My Machines again on it, which offers to install NVIDIA's CDI support \(the NVIDIA Container Toolkit\), restart k3s there once it is installed, then deploy again\.$/);
    expect([...new Set(asked)].sort()).toEqual(['daemonset', 'events', 'nodes', 'pods']);
  });

  it('refuses a deploy that did not say how many GPUs it uses, touching nothing', async () => {
    await expect(VerifyGpuRuntimeActivity({ clusterId: 'machine-desk', reach: DESK, vendor: 'nvidia' }, { access })).rejects.toThrow('did not say how many GPUs it uses');
    expect(access.apply).not.toHaveBeenCalled();
  });
});

describe('removing an app', () => {
  const base = { name: 'shop', clusterId: 'machine-desk', clusterName: 'desk', strategy: 'native', logFile: LOG, deploymentId: 'd1', namespace: 'shop-1a2b3c', reach: DESK };

  it('destroys its stack with the kubeconfig of the cluster it was handed, then waits for its namespace to go', async () => {
    await DestroyAppActivity(base, steps());
    expect(infra.destroy).toHaveBeenCalledWith('app-desk-d1', { logFile: LOG, env: expect.objectContaining({ KUBECONFIG: '/clusters/kubeconfig-machine', CLUSTER_NAME: 'desk', DEPLOYMENT_NAME: 'shop-1a2b3c', APP_SERVICE_TYPE: 'NodePort' }) as unknown });
    expect(infra.destroy.mock.calls[0]![1]?.env).not.toHaveProperty('KUBECONFIG_CONTEXT');
    expect(infra.destroy.mock.calls[0]![1]?.env).not.toHaveProperty('SELF_MANAGED_K8S');
    expect(said.map((call) => [call.reach, call.args.slice(0, 3)])).toEqual([
      [DESK, ['delete', 'namespace', 'shop-1a2b3c']],
      [DESK, ['wait', '--for=delete', 'namespace/shop-1a2b3c']],
    ]);
  });

  it('uninstalls an Odoo release with helm and removes its namespace, with no stack', async () => {
    await DestroyAppActivity({ ...base, appType: ODOO_PROJECT_APP }, steps());
    expect(access.helm).toHaveBeenCalledWith(DESK, ['uninstall', 'shop-1a2b3c', '-n', 'shop-1a2b3c', '--ignore-not-found']);
    expect(infra.destroy).not.toHaveBeenCalled();
    expect(said.map((call) => call.args[0])).toEqual(['delete', 'wait']);
  });

  it('never touches a platform namespace', async () => {
    await expect(DestroyAppActivity({ ...base, namespace: 'kube-system' }, steps())).rejects.toThrow();
    expect(access.kubectl).not.toHaveBeenCalled();
    expect(infra.destroy).not.toHaveBeenCalled();
  });

  it('is refused, touching nothing, when it was handed no stack id', async () => {
    const { deploymentId: _id, ...unnamed } = base;
    await expect(DestroyAppActivity(unnamed as typeof base, steps())).rejects.toThrow('handed no stack id');
    expect(infra.destroy).not.toHaveBeenCalled();
    expect(access.kubectl).not.toHaveBeenCalled();
  });

  it('fails with the cluster\'s reason when it cannot be reached, and removes nothing', async () => {
    access.kubeconfigOf.mockRejectedValue(new ClusterUnreachable('machine-dev1', 'no-account', 'this process is not running inside Koala\'s cluster, so it has no account there to reach it with'));
    await expect(DestroyAppActivity({ ...base, reach: KOALA }, steps())).rejects.toThrow('no account there to reach it with');
    expect(infra.destroy).not.toHaveBeenCalled();
  });
});

describe('resizing an app\'s disk', () => {
  it('applies its stack again with the new sizes, through the kubeconfig of the cluster it was handed', async () => {
    await ResizeDiskActivity({ name: 'shop', clusterId: 'machine-dev1', reach: KOALA, clusterName: 'koala', strategy: 'native', appType: 'wordpress', storage: { db: '20Gi' }, logFile: LOG, deploymentId: 'd1' }, steps());
    expect(access.kubeconfigOf).toHaveBeenCalledWith(KOALA);
    expect(infra.deploy).toHaveBeenCalledWith('app-koala-d1', { logFile: LOG, env: expect.objectContaining({ KUBECONFIG: '/clusters/kubeconfig-koala', APP_TYPE: 'wordpress', APP_SERVICE_TYPE: 'NodePort' }) as unknown, signal: expect.any(AbortSignal) as unknown });
    expect(infra.deploy.mock.calls[0]![1]?.env).not.toHaveProperty('KUBECONFIG_CONTEXT');
  });

  it('is refused when it was handed no way to reach the cluster', async () => {
    await expect(ResizeDiskActivity({ name: 'shop', clusterId: 'c', clusterName: 'c', strategy: 'native', appType: 'wordpress', storage: {}, logFile: LOG, deploymentId: 'd1' }, steps())).rejects.toThrow('handed no way to reach c');
    expect(infra.deploy).not.toHaveBeenCalled();
  });
});

describe('an app handed no stack id', () => {
  it('is neither resized nor synced, so no other app\'s state is applied over', async () => {
    const unnamed = { name: 'shop', clusterId: 'machine-dev1', reach: KOALA, clusterName: 'koala', strategy: 'native', appType: 'wordpress', logFile: LOG };
    await expect(ResizeDiskActivity({ ...unnamed, storage: { db: '20Gi' } } as never, steps())).rejects.toThrow('handed no stack id');
    await expect(SyncConfigActivity(unnamed as never, steps())).rejects.toThrow('handed no stack id');
    expect(infra.deploy).not.toHaveBeenCalled();
  });
});

describe('syncing an app\'s settings', () => {
  it('applies its stack, restarts its deployments and pushes Open WebUI\'s search settings, all on the cluster it was handed', async () => {
    access.kubectl.mockImplementation(async (target, args) => {
      said.push({ reach: target as Reach, args });
      if (args.includes('deployments,statefulsets,daemonsets,replicasets,jobs,pods')) return JSON.stringify({ items: [{ kind: 'Deployment', metadata: { name: 'open-webui', generation: 1 }, spec: { replicas: 0 }, status: { observedGeneration: 1 } }] });
      return 'OK';
    });
    await SyncConfigActivity({ name: 'chat', namespace: 'chat-1', clusterId: 'machine-desk', reach: DESK, clusterName: 'desk', strategy: 'native', appType: 'openwebui', logFile: LOG, deploymentId: 'd2', webuiEnableWebSearch: true }, steps());
    expect(infra.deploy.mock.calls[0]![1]?.env).toMatchObject({ KUBECONFIG: '/clusters/kubeconfig-machine', APP_SERVICE_TYPE: 'NodePort' });
    expect(said.every((call) => call.reach === DESK)).toBe(true);
    expect(said.map((call) => call.args.slice(0, 3).join(' '))).toEqual(['rollout restart deployment', '-n chat-1 get', 'exec -n chat-1']);
  });
});

describe('an app\'s stack, as the cluster worker serves its steps', () => {
  const stopsWhenCancelled = (activity: MockActivityEnvironment) => {
    infra.deploy.mockImplementation((_stack, options) => new Promise((_done, refuse) => {
      options!.signal!.addEventListener('abort', () => refuse(new Error('terraform was stopped')), { once: true });
      activity.cancel();
    }));
  };

  it('resizing applies the stack the app was deployed as, and stops applying it when the step is cancelled', async () => {
    const activity = new MockActivityEnvironment();
    stopsWhenCancelled(activity);
    await expect(activity.run(clusterActivities(steps(), mock<ClusterSetup>()).ResizeDiskActivity, { name: 'shop', clusterId: 'machine-desk', reach: DESK, clusterName: 'desk', strategy: 'native', appType: 'wordpress', storage: { db: '20Gi' }, logFile: LOG, deploymentId: 'd1' })).rejects.toThrow();
    expect(infra.deploy).toHaveBeenCalledWith('app-desk-d1', expect.anything());
    expect(infra.deploy.mock.calls[0]![1]!.signal?.aborted).toBe(true);
  });

  it('syncing settings applies the stack the app was deployed as, and stops applying it when the step is cancelled', async () => {
    const activity = new MockActivityEnvironment();
    stopsWhenCancelled(activity);
    await expect(activity.run(clusterActivities(steps(), mock<ClusterSetup>()).SyncConfigActivity, { name: 'chat', namespace: 'chat-1', clusterId: 'machine-desk', reach: DESK, clusterName: 'desk', strategy: 'native', appType: 'openwebui', logFile: LOG, deploymentId: 'd2' })).rejects.toThrow();
    expect(infra.deploy).toHaveBeenCalledWith('app-desk-d2', expect.anything());
    expect(infra.deploy.mock.calls[0]![1]!.signal?.aborted).toBe(true);
  });

  it('removing the app destroys the stack it was deployed as', async () => {
    const done = await new MockActivityEnvironment().run(clusterActivities(steps(), mock<ClusterSetup>()).DestroyAppActivity, { name: 'shop', clusterId: 'machine-desk', clusterName: 'desk', strategy: 'native', logFile: LOG, deploymentId: 'd1', namespace: 'shop-1a2b3c', reach: DESK });
    expect(done).toMatchObject({ status: 'destroyed' });
    expect(infra.destroy).toHaveBeenCalledWith('app-desk-d1', expect.anything());
  });
});

describe('building a project\'s image', () => {
  const run = { projectId: 'p1', giteaOwner: 'acme', giteaRepo: 'shop', commitSha: 'a'.repeat(40), ref: 'main', logFile: LOG, runId: 'run-1' };

  beforeEach(() => {
    gitea.getRegistryHosts.mockResolvedValue({ push: 'gitea-http.gitea:3000', pull: '127.0.0.1:31737' });
    gitea.getRawFile.mockImplementation(async (_owner: string, _repo: string, file: string) => (file === 'Dockerfile' ? 'FROM scratch' : null));
    gitea.createDeployToken.mockResolvedValue({ name: 'build-token', token: 't0ken' });
    gitea.revokeToken.mockResolvedValue(undefined);
    access.own.mockReturnValue(KOALA);
    access.follow.mockResolvedValue(mock<Followed>());
  });

  it('runs the build job on the cluster Koala runs in, follows its log there, and cleans up there', async () => {
    access.kubectl.mockImplementation(async (target, args) => {
      said.push({ reach: target as Reach, args });
      if (args[0] === 'get' && args[1] === 'pods' && args.includes('jsonpath={.items[0].metadata.name}')) return 'build-shop-aaaaaaaa-run1-x';
      if (args[0] === 'get' && args[1] === 'job') return '1|';
      return '';
    });
    const built = await RunPipelineActivity(run, steps());
    expect(built).toEqual({ status: 'succeeded', imageTag: `127.0.0.1:31737/acme/shop:${'a'.repeat(40)}` });
    expect(access.apply).toHaveBeenCalledWith(KOALA, expect.stringContaining('kind: Job') as unknown);
    expect(access.follow).toHaveBeenCalledWith(KOALA, ['logs', '-f', 'build-shop-aaaaaaaa-run1-x', '-n', 'pipeline-builds', '--all-containers=true'], expect.any(Function) as unknown);
    expect(said.every((call) => call.reach === KOALA)).toBe(true);
    expect(said.slice(-2).map((call) => call.args.slice(0, 2).join(' '))).toEqual(['delete job', 'delete secret']);
    expect(gitea.revokeToken).toHaveBeenCalledWith('build-token');
  });

  it('fails when Koala\'s own cluster cannot be reached, having revoked the token it made', async () => {
    access.apply.mockRejectedValue(new ClusterUnreachable('machine-dev1', 'no-account', 'this process is not running inside Koala\'s cluster'));
    await expect(RunPipelineActivity(run, steps())).rejects.toThrow('not running inside Koala\'s cluster');
    expect(gitea.revokeToken).toHaveBeenCalledWith('build-token');
  });
});
