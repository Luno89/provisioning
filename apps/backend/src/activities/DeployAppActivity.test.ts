import { records } from './testing/recorded-database.js';
import { mkdtempSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { MockActivityEnvironment } from '@temporalio/testing';
import { readFileSync } from 'node:fs';
import { ClusterUnreachable, type ClusterAccess, type InfrastructureService, type Provisioner, type ProvisioningRecord, type Reach } from '../infrastructure/index.js';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import { interceptHttp } from '../platform/testing/http.js';
import type { DeployAppArgs } from './DeployAppActivity.js';
import { answerAsACluster, stepsOn } from './testing/answering-cluster.js';

const { DeployAppActivity } = await import('./DeployAppActivity.js');
const { clusterActivities } = await import('../worker-cluster.js');
type ClusterSetup = import('../worker-cluster.js').ClusterSetup;

const huggingFace = interceptHttp();
const MODEL_TREE = 'https://huggingface.co/api/models/org/model/tree/*';

const DESK: Reach = { clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1\nkind: Config\n' };
const LOG = join(mkdtempSync(join(tmpdir(), 'deploy-app-')), 'deploy.log');

let access: MockProxy<ClusterAccess>;
let infra: MockProxy<InfrastructureService>;
let reached: Reach[];
let nodes: string;
let provisioner: MockProxy<Provisioner>;

const steps = () => ({ ...stepsOn(access, infra, 'cluster-steps-test-key'), provisioner });

const noMonitoring = () => access.kubectl.mockImplementation(async (target, args) => {
  reached.push(target as Reach);
  if (args[0] === 'get' && args[1] === 'nodes') return nodes;
  if (args[1] === 'deployments,statefulsets,daemonsets,replicasets,jobs,pods') return JSON.stringify({ items: [] });
  return '';
});

const deploy = (over: Partial<DeployAppArgs> = {}): DeployAppArgs => ({
  name: 'blog', namespace: 'blog-1a2b3c', clusterId: 'machine-desk', reach: DESK, clusterName: 'desk',
  machine: { deviceId: 'desk' }, strategy: 'native', appType: 'wordpress', odooRepo: '', odooTag: '', dbRepo: '', dbTag: '',
  logFile: LOG, deploymentId: 'd1', ...over,
});

beforeEach(async () => {
  records.db = memoryDatabase();
  await records.db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy' } as never);
  access = mock<ClusterAccess>();
  infra = mock<InfrastructureService>();
  reached = [];
  nodes = '64Gi';
  answerAsACluster(access, { reached: (target) => reached.push(target), nodes: () => nodes });
  infra.deploy.mockResolvedValue({ stdout: '', logFile: LOG });
  provisioner = mock<Provisioner>();
  provisioner.ensure.mockImplementation(async (target) => ({ id: `provision-${target.clusterId}~1` }) as ProvisioningRecord);
  provisioner.settled.mockResolvedValue({ state: 'up' });
});

describe('deploying an app on the cluster it was handed', () => {
  it('applies the app\'s stack with that cluster\'s kubeconfig and no context, and reaches nothing else', async () => {
    const done = await DeployAppActivity(deploy(), steps());
    expect(done.status).toBe('running');
    expect(infra.deploy).toHaveBeenCalledWith('app-desk-d1', { logFile: LOG, env: expect.objectContaining({ KUBECONFIG: '/clusters/kubeconfig-machine-desk', CLUSTER_NAME: 'desk', DEPLOYMENT_NAME: 'blog-1a2b3c', APP_SERVICE_TYPE: 'NodePort' }) as unknown, signal: expect.any(AbortSignal) as unknown });
    expect(infra.deploy.mock.calls.at(-1)![1]?.env).not.toHaveProperty('KUBECONFIG_CONTEXT');
    expect(infra.deploy.mock.calls.at(-1)![1]?.env).not.toHaveProperty('SELF_MANAGED_K8S');
    expect(new Set(reached)).toEqual(new Set([DESK]));
    expect(access.kubeconfigOf.mock.calls.every(([target]) => target === DESK)).toBe(true);
  });

  it('goes straight to the app on a cluster whose monitoring is there, asking Koala to set nothing up', async () => {
    await DeployAppActivity(deploy(), steps());
    expect(provisioner.ensure).not.toHaveBeenCalled();
    expect(infra.deploy.mock.calls.map(([stack]) => stack)).toEqual(['app-desk-d1']);
  });

  it('asks Koala to set up a machine\'s collector when the machine has none, waits until it is set up, saying so, then deploys the app, applying no monitoring itself', async () => {
    noMonitoring();
    let settle!: () => void;
    let waiting!: (recordId: string) => void;
    const waited = new Promise<string>((done) => { waiting = done; });
    provisioner.settled.mockImplementation((recordId) => new Promise((done) => { settle = () => done({ state: 'up' }); waiting(recordId); }));
    const deploying = DeployAppActivity(deploy(), steps());
    expect(await waited).toBe('provision-machine-desk~1');
    expect(provisioner.ensure).toHaveBeenCalledWith({ kind: 'machine', clusterId: 'machine-desk', machine: 'desk', deviceId: 'desk' }, 'missing');
    expect(readFileSync(LOG, 'utf8')).toContain('[deploy] waiting for Koala to set up its monitoring of desk before blog goes on it');
    expect(infra.deploy).not.toHaveBeenCalled();
    settle();
    await deploying;
    expect(infra.deploy.mock.calls.map(([stack]) => stack)).toEqual(['app-desk-d1']);
    expect(access.apply).not.toHaveBeenCalled();
  });

  it('fails, naming the piece and why, when Koala could not set up the monitoring, and deploys nothing', async () => {
    noMonitoring();
    provisioner.settled.mockResolvedValue({ state: 'failed', why: 'desk\'s collector: helm said no' });
    await expect(DeployAppActivity(deploy(), steps())).rejects.toThrow('Koala could not set up the monitoring of desk, which blog needs before it goes on: desk\'s collector: helm said no');
    expect(infra.deploy).not.toHaveBeenCalled();
  });

  it('reads the nodes\' memory through the cluster it was handed to plan TabbyAPI\'s, and refuses a node too small', async () => {
    nodes = '1Gi';
    huggingFace.use(http.get(MODEL_TREE, () => HttpResponse.json([{ type: 'file', path: 'model.safetensors', size: 4e9 }])));
    await expect(DeployAppActivity(deploy({ appType: 'tabbyapi', tabbyModel: 'org/model', tabbyGpuCount: 1, tabbyMaxSeqLen: 32768 }), steps())).rejects.toThrow(/of host RAM but only .* is available on the node \(1\.0 GiB allocatable/);
    expect(access.kubectl).toHaveBeenCalledWith(DESK, ['get', 'nodes', '-o', 'jsonpath={.items[*].status.allocatable.memory}']);
    expect(infra.deploy.mock.calls.map(([stack]) => stack)).not.toContain('app-desk-d1');
  });

  it('makes Palworld\'s passwords on that cluster when it has none, and restarts it there', async () => {
    await DeployAppActivity(deploy({ appType: 'palworld' }), steps());
    expect(access.apply).toHaveBeenCalledWith(DESK, 'apiVersion: v1\nkind: Secret\n');
    expect(access.kubectl).toHaveBeenCalledWith(DESK, ['rollout', 'restart', 'deployment/palworld', '-n', 'blog-1a2b3c']);
  });

  it('refuses Odoo modules to bake into an image before it touches any cluster, since no cluster pulls from this computer\'s Docker', async () => {
    await expect(DeployAppActivity(deploy({ appType: 'odoo', modules: ['sale'] }), steps())).rejects.toThrow('release the modules through the project\'s repository instead');
    expect(access.kubectl).not.toHaveBeenCalled();
    expect(infra.deploy).not.toHaveBeenCalled();
  });

  it('fails with why when the cluster cannot be reached, and applies nothing', async () => {
    access.kubeconfigOf.mockRejectedValue(new ClusterUnreachable('machine-desk', 'no-account', 'this process is not running inside Koala\'s cluster'));
    await expect(DeployAppActivity(deploy(), steps())).rejects.toThrow('not running inside Koala\'s cluster');
    expect(infra.deploy).not.toHaveBeenCalled();
  });

  it('on Koala\'s servers, asks Koala to set its pool place up when it lacks the operator\'s resources, then keeps the app behind a ClusterIP with the pool\'s storage', async () => {
    const POOL: Reach = { clusterId: 'pool-bob', kind: 'koala' };
    Object.defineProperty(access, 'here', { value: { root: false, poolName: 'bob' }, configurable: true });
    access.kubectl.mockImplementation(async (_target, args) => (args[1] === 'deployments,statefulsets,daemonsets,replicasets,jobs,pods' ? JSON.stringify({ items: [] }) : ''));
    await DeployAppActivity(deploy({ clusterId: 'pool-bob', reach: POOL, clusterName: 'pool-bob', machine: undefined }), steps());
    expect(provisioner.ensure).toHaveBeenCalledWith({ kind: 'koala', clusterId: 'pool-bob' }, 'missing');
    const [app, ...more] = infra.deploy.mock.calls;
    expect(more).toEqual([]);
    expect([app![0], app![1]?.env]).toEqual(['app-pool-bob-d1', expect.objectContaining({ APP_SERVICE_TYPE: 'ClusterIP', MINIO_STORAGE: '10Gi' })]);
  });

  it('asks Koala to set its own cluster up when its monitoring is missing, and puts the app behind a NodePort once it is', async () => {
    const OWN: Reach = { clusterId: 'machine-home', kind: 'koala' };
    noMonitoring();
    await DeployAppActivity(deploy({ clusterId: 'machine-home', reach: OWN, clusterName: 'home', machine: undefined }), steps());
    expect(provisioner.ensure).toHaveBeenCalledWith({ kind: 'koala', clusterId: 'machine-home' }, 'missing');
    expect(provisioner.settled).toHaveBeenCalledWith('provision-machine-home~1');
    const [app, ...more] = infra.deploy.mock.calls;
    expect(more).toEqual([]);
    expect([app![0], app![1]?.env]).toEqual(['app-home-d1', expect.objectContaining({ APP_SERVICE_TYPE: 'NodePort' })]);
    expect(access.apply).not.toHaveBeenCalled();
  });

  it('is refused when it was handed no way to reach the cluster', async () => {
    await expect(DeployAppActivity(deploy({ reach: undefined }), steps())).rejects.toThrow('handed no way to reach machine-desk');
    expect(infra.deploy).not.toHaveBeenCalled();
  });

  it('as the cluster worker serves it, applies the app\'s stack and stops applying it when the step is cancelled', async () => {
    const activity = new MockActivityEnvironment();
    let appSignal: AbortSignal | undefined;
    infra.deploy.mockImplementation((stack, options) => (stack !== 'app-desk-d1' ? Promise.resolve({ stdout: '', logFile: LOG }) : new Promise((_done, refuse) => {
      appSignal = options!.signal;
      options!.signal!.addEventListener('abort', () => refuse(new Error('terraform was stopped')), { once: true });
      activity.cancel();
    })));
    await expect(activity.run(clusterActivities(steps(), mock<ClusterSetup>()).DeployAppActivity, deploy())).rejects.toThrow();
    expect(infra.deploy).toHaveBeenCalledWith('app-desk-d1', expect.anything());
    expect(appSignal?.aborted).toBe(true);
  });
});

describe('what TabbyAPI\'s memory plan rests on', () => {
  const tabby = (over: Partial<DeployAppArgs> = {}) => deploy({ appType: 'tabbyapi', tabbyModel: 'org/model', tabbyGpuCount: 1, tabbyMaxSeqLen: 4096, ...over });

  it('stops, saying what to set, when Hugging Face cannot say how big the model is and the person set no memory', async () => {
    huggingFace.use(http.get(MODEL_TREE, () => new HttpResponse(null, { status: 503 })));
    await expect(DeployAppActivity(tabby(), steps())).rejects.toThrow(/^Koala could not read how big org\/model is from Hugging Face \(.*503.*\), so it cannot size the memory it needs\. Set its Memory Limit \(RAM\) and Shared Memory \(\/dev\/shm\)/);
    expect(infra.deploy.mock.calls.map(([stack]) => stack)).not.toContain('app-desk-d1');
  });

  it('goes ahead on the memory the person set when Hugging Face cannot say how big the model is, and says so', async () => {
    huggingFace.use(http.get(MODEL_TREE, () => new HttpResponse(null, { status: 503 })));
    const done = await DeployAppActivity(tabby({ tabbyMemoryLimit: '48G', tabbyShmSize: '16Gi' }), steps());
    expect(done.notes).toEqual([expect.stringMatching(/^Memory is the 48G and 16Gi of shared memory you set: Hugging Face could not say how big org\/model is \(.*503.*\)\.$/)]);
    const app = infra.deploy.mock.calls.find(([stack]) => stack === 'app-desk-d1');
    expect(app?.[1]?.env).toMatchObject({ TABBYAPI_MEMORY_LIMIT: '48G', TABBYAPI_SHM_SIZE: '16Gi' });
  });

  it('stops, saying so, when it is given no model to serve', async () => {
    await expect(DeployAppActivity(deploy({ appType: 'tabbyapi', tabbyGpuCount: 1 }), steps())).rejects.toThrow('TabbyAPI was given no model to serve');
    expect(infra.deploy.mock.calls.map(([stack]) => stack)).not.toContain('app-desk-d1');
  });

  it('stops, saying why, when Hugging Face answers that the model is not there', async () => {
    huggingFace.use(http.get(MODEL_TREE, () => new HttpResponse(null, { status: 404 })));
    await expect(DeployAppActivity(tabby(), steps())).rejects.toThrow(/^Hugging Face could not say how big org\/model is: /);
    expect(infra.deploy.mock.calls.map(([stack]) => stack)).not.toContain('app-desk-d1');
  });

  it('stops when the machine\'s nodes report no memory it can read, which is no outage', async () => {
    huggingFace.use(http.get(MODEL_TREE, () => HttpResponse.json([{ type: 'file', path: 'model.safetensors', size: 4e9 }])));
    nodes = '';
    await expect(DeployAppActivity(tabby(), steps())).rejects.toThrow('the machine\'s nodes report no memory Koala can read ("")');
  });

  it('goes ahead without the fit check while the machine does not answer, and says so; a refusal of the read stops it', async () => {
    huggingFace.use(http.get(MODEL_TREE, () => HttpResponse.json([{ type: 'file', path: 'model.safetensors', size: 4e9 }])));
    const answering = access.kubectl.getMockImplementation()!;
    access.kubectl.mockImplementation(async (target, args) => {
      if (args[1] === 'nodes') throw Object.assign(new Error('connect ECONNREFUSED 100.64.0.7:6443'), { code: 'ECONNREFUSED' });
      return answering(target, args);
    });
    const done = await DeployAppActivity(tabby(), steps());
    expect(done.notes).toEqual([expect.stringMatching(/^Whether the model fits in the machine's memory was not checked: the machine's memory could not be read \(/)]);
    access.kubectl.mockImplementation(async (target, args) => {
      if (args[1] === 'nodes') throw new Error('nodes is forbidden: User "koala" cannot list resource "nodes"');
      return answering(target, args);
    });
    await expect(DeployAppActivity(tabby(), steps())).rejects.toThrow(/^the machine's memory could not be read: nodes is forbidden/);
  });
});
