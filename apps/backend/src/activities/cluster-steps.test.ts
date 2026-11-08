import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ClusterUnreachable, type ClusterAccess, type InfrastructureService, type Reach } from '../infrastructure/index.js';
import { ODOO_PROJECT_APP } from '../releases/index.js';
import type { Followed } from '../platform/index.js';
import { CheckWorkloadActivity } from './CheckWorkloadActivity.js';
import { DestroyAppActivity } from './DestroyAppActivity.js';
import { ResizeDiskActivity } from './ResizeDiskActivity.js';
import { SyncConfigActivity } from './SyncConfigActivity.js';
import { VerifyGpuRuntimeActivity } from './VerifyGpuRuntimeActivity.js';
import { handedReach } from './handed-reach.js';

const gitea = vi.hoisted(() => ({
  getRegistryHosts: vi.fn(),
  getRawFile: vi.fn(),
  createDeployToken: vi.fn(),
  revokeToken: vi.fn(),
  made: [] as unknown[][],
}));

vi.mock('../projects/index.js', async (actual) => ({
  ...(await actual<typeof import('../projects/index.js')>()),
  GiteaService: class {
    adminUsername = 'koala-bot';
    constructor(...args: unknown[]) { gitea.made.push(args); }
    getRegistryHosts = gitea.getRegistryHosts;
    getRawFile = gitea.getRawFile;
    createDeployToken = gitea.createDeployToken;
    revokeToken = gitea.revokeToken;
  },
}));

const { RunPipelineActivity } = await import('./RunPipelineActivity.js');

const DESK: Reach = { clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1\nkind: Config\n' };
const KOALA: Reach = { clusterId: 'machine-dev1', kind: 'koala' };
const LOG = join(mkdtempSync(join(tmpdir(), 'cluster-steps-')), 'step.log');

let access: MockProxy<ClusterAccess>;
let infra: MockProxy<InfrastructureService>;
let said: Array<{ reach: Reach; args: readonly string[] }>;

beforeEach(() => {
  access = mock<ClusterAccess>();
  infra = mock<InfrastructureService>();
  said = [];
  access.kubeconfigOf.mockImplementation(async (target) => `/clusters/kubeconfig-${(target as Reach).kind}`);
  access.kubectl.mockImplementation(async (target, args) => { said.push({ reach: target as Reach, args }); return ''; });
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
  const pods = (items: unknown[]) => JSON.stringify({ items });
  const running = { metadata: { name: 'shop-1' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] } };

  it('reads the pods of the app\'s namespace on the cluster it was handed', async () => {
    access.kubectl.mockResolvedValueOnce(pods([running]));
    const read = await CheckWorkloadActivity({ name: 'shop', namespace: 'shop-1a2b3c', clusterId: 'machine-desk', reach: DESK }, { access });
    expect(read.health).toBe('healthy');
    expect(access.kubectl).toHaveBeenCalledWith(DESK, ['get', 'pods', '-n', 'shop-1a2b3c', '-o', 'json']);
  });

  it('asks the controllers too while nothing has started, and says when the cluster refuses to make the pods', async () => {
    access.kubectl.mockResolvedValueOnce(pods([]));
    access.kubectl.mockResolvedValueOnce(JSON.stringify({ items: [{ kind: 'ReplicaSet', metadata: { name: 'shop-7c' }, status: { conditions: [{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: 'exceeded quota: koala' }] } }] }));
    const read = await CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk', reach: DESK }, { access });
    expect(access.kubectl).toHaveBeenLastCalledWith(DESK, ['get', 'deployments,replicasets', '-n', 'shop', '-o', 'json']);
    expect(read.health).toBe('unhealthy');
    expect(read.reason).toContain('exceeded quota');
  });

  it('says the workload could not be read, with why, when the cluster cannot be reached', async () => {
    access.kubectl.mockRejectedValue(new ClusterUnreachable('machine-desk', 'stopped', 'desk is stopped until something runs on it'));
    expect(await CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk', reach: DESK }, { access })).toEqual({ health: 'unknown', reason: 'could not read the workload: desk is stopped until something runs on it' });
  });

  it('fails at once when it was handed no way to reach the cluster', async () => {
    await expect(CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-desk' }, { access })).rejects.toThrow('handed no way to reach machine-desk');
    expect(access.kubectl).not.toHaveBeenCalled();
  });
});

describe('making a GPU runtime ready', () => {
  it('installs the device plugin and proves a pod schedules on its runtime, all on the cluster it was handed', async () => {
    access.kubectl.mockImplementation(async (target, args) => {
      said.push({ reach: target as Reach, args });
      if (args[0] === 'get' && args[1] === 'pods') return JSON.stringify({ items: [{ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }] });
      if (args[0] === 'get' && args[1] === 'events') return JSON.stringify({ items: [] });
      if (args[0] === 'get' && args[1] === 'pod') return JSON.stringify({ status: { phase: 'Running' } });
      return '';
    });
    await VerifyGpuRuntimeActivity({ clusterId: 'machine-desk', reach: DESK, vendor: 'nvidia' }, { access });
    expect(said.every((call) => call.reach === DESK)).toBe(true);
    expect(said.map((call) => call.args.slice(0, 2).join(' '))).toEqual(expect.arrayContaining(['apply -f', 'get daemonset', 'get runtimeclass', 'run ' + said.find((call) => call.args[0] === 'run')!.args[1], 'delete pod']));
  }, 20_000);

  it('fails, saying so, when the runtime class is missing', async () => {
    access.kubectl.mockImplementation(async (_target, args) => {
      if (args[0] === 'get' && args[1] === 'runtimeclass') throw new Error('not found');
      if (args[0] === 'get' && args[1] === 'pods') return JSON.stringify({ items: [{ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }] });
      return '';
    });
    await expect(VerifyGpuRuntimeActivity({ clusterId: 'machine-desk', reach: DESK, vendor: 'nvidia' }, { access })).rejects.toThrow('GPU RuntimeClass "nvidia" is not installed on this cluster');
  });
});

describe('removing an app', () => {
  const base = { name: 'shop', clusterId: 'machine-desk', clusterName: 'desk', provider: 'machine', strategy: 'native', logFile: LOG, deploymentId: 'd1', namespace: 'shop-1a2b3c', reach: DESK };

  it('destroys its stack with the kubeconfig of the cluster it was handed, then waits for its namespace to go', async () => {
    await DestroyAppActivity(base, { access, infra });
    expect(infra.destroy).toHaveBeenCalledWith('app-desk-d1', { logFile: LOG, env: expect.objectContaining({ KUBECONFIG: '/clusters/kubeconfig-machine', CLUSTER_NAME: 'desk', DEPLOYMENT_NAME: 'shop-1a2b3c', SELF_MANAGED_K8S: 'true' }) as unknown });
    expect(infra.destroy.mock.calls[0]![1]?.env).not.toHaveProperty('KUBECONFIG_CONTEXT');
    expect(said.map((call) => [call.reach, call.args.slice(0, 3)])).toEqual([
      [DESK, ['delete', 'namespace', 'shop-1a2b3c']],
      [DESK, ['wait', '--for=delete', 'namespace/shop-1a2b3c']],
    ]);
  });

  it('uninstalls an Odoo release with helm and removes its namespace, with no stack', async () => {
    await DestroyAppActivity({ ...base, appType: ODOO_PROJECT_APP }, { access, infra });
    expect(access.helm).toHaveBeenCalledWith(DESK, ['uninstall', 'shop-1a2b3c', '-n', 'shop-1a2b3c', '--ignore-not-found']);
    expect(infra.destroy).not.toHaveBeenCalled();
    expect(said.map((call) => call.args[0])).toEqual(['delete', 'wait']);
  });

  it('never touches a platform namespace', async () => {
    await expect(DestroyAppActivity({ ...base, namespace: 'kube-system' }, { access, infra })).rejects.toThrow();
    expect(access.kubectl).not.toHaveBeenCalled();
    expect(infra.destroy).not.toHaveBeenCalled();
  });

  it('fails with the cluster\'s reason when it cannot be reached, and removes nothing', async () => {
    access.kubeconfigOf.mockRejectedValue(new ClusterUnreachable('machine-dev1', 'no-account', 'this process is not running inside Koala\'s cluster, so it has no account there to reach it with'));
    await expect(DestroyAppActivity({ ...base, reach: KOALA }, { access, infra })).rejects.toThrow('no account there to reach it with');
    expect(infra.destroy).not.toHaveBeenCalled();
  });
});

describe('resizing an app\'s disk', () => {
  it('applies its stack again with the new sizes, through the kubeconfig of the cluster it was handed', async () => {
    await ResizeDiskActivity({ name: 'shop', clusterId: 'machine-dev1', reach: KOALA, clusterName: 'provisioning-lunorica', provider: 'k3d', strategy: 'native', appType: 'wordpress', storage: { db: '20Gi' }, logFile: LOG, deploymentId: 'd1' }, { access, infra });
    expect(access.kubeconfigOf).toHaveBeenCalledWith(KOALA);
    expect(infra.deploy).toHaveBeenCalledWith('app-provisioning-lunorica-d1', { logFile: LOG, env: expect.objectContaining({ KUBECONFIG: '/clusters/kubeconfig-koala', APP_TYPE: 'wordpress' }) as unknown });
    expect(infra.deploy.mock.calls[0]![1]?.env).not.toHaveProperty('KUBECONFIG_CONTEXT');
  });

  it('is refused when it was handed no way to reach the cluster', async () => {
    await expect(ResizeDiskActivity({ name: 'shop', clusterId: 'c', clusterName: 'c', provider: 'machine', strategy: 'native', appType: 'wordpress', storage: {}, logFile: LOG }, { access, infra })).rejects.toThrow('handed no way to reach c');
    expect(infra.deploy).not.toHaveBeenCalled();
  });
});

describe('syncing an app\'s settings', () => {
  it('applies its stack, restarts its deployments and pushes Open WebUI\'s search settings, all on the cluster it was handed', async () => {
    access.kubectl.mockImplementation(async (target, args) => {
      said.push({ reach: target as Reach, args });
      if (args.includes('rollout') && args.includes('status')) return 'deployment "open-webui" successfully rolled out';
      return 'OK';
    });
    await SyncConfigActivity({ name: 'chat', namespace: 'chat-1', clusterId: 'machine-desk', reach: DESK, clusterName: 'desk', provider: 'machine', strategy: 'native', appType: 'openwebui', logFile: LOG, deploymentId: 'd2', webuiEnableWebSearch: true }, { access, infra });
    expect(infra.deploy.mock.calls[0]![1]?.env).toMatchObject({ KUBECONFIG: '/clusters/kubeconfig-machine' });
    expect(said.every((call) => call.reach === DESK)).toBe(true);
    expect(said.map((call) => call.args.slice(0, 3).join(' '))).toEqual(['rollout restart deployment', '-n chat-1 rollout', 'exec -n chat-1']);
  });
});

describe('building a project\'s image', () => {
  const run = { projectId: 'p1', giteaOwner: 'acme', giteaRepo: 'shop', commitSha: 'a'.repeat(40), ref: 'main', logFile: LOG, runId: 'run-1' };

  beforeEach(() => {
    gitea.made.length = 0;
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
    const built = await RunPipelineActivity(run, { access, infra });
    expect(built).toEqual({ status: 'succeeded', imageTag: `127.0.0.1:31737/acme/shop:${'a'.repeat(40)}` });
    expect(access.apply).toHaveBeenCalledWith(KOALA, expect.stringContaining('kind: Job') as unknown);
    expect(access.follow).toHaveBeenCalledWith(KOALA, ['logs', '-f', 'build-shop-aaaaaaaa-run1-x', '-n', 'pipeline-builds', '--all-containers=true'], expect.any(Function) as unknown);
    expect(said.every((call) => call.reach === KOALA)).toBe(true);
    expect(said.slice(-2).map((call) => call.args.slice(0, 2).join(' '))).toEqual(['delete job', 'delete secret']);
    expect(gitea.made[0]![2]).toBe('/clusters/kubeconfig-koala');
    expect(gitea.revokeToken).toHaveBeenCalledWith('build-token');
  });

  it('fails when Koala\'s own cluster cannot be reached, having revoked the token it made', async () => {
    access.apply.mockRejectedValue(new ClusterUnreachable('machine-dev1', 'no-account', 'this process is not running inside Koala\'s cluster'));
    await expect(RunPipelineActivity(run, { access, infra })).rejects.toThrow('not running inside Koala\'s cluster');
    expect(gitea.revokeToken).toHaveBeenCalledWith('build-token');
  });
});
