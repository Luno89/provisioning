import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkflowFailedError } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClusterSteps } from '../activities/cluster-steps.js';
import { ClusterAccess, startedMachine, type Reach } from '../infrastructure/index.js';
import { startHuggingFaceStandIn, STAND_IN_IMAGE, type HuggingFaceStandIn } from '../infrastructure/testing/hugging-face-stand-in.js';
import { privateCluster } from '../infrastructure/testing/private-cluster.js';
import { CLUSTER_TOOL_PATHS } from '../infrastructure/index.js';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { clusterActivities } from '../worker-cluster.js';
import { bundled, temporalTestEnvironment, type TestTemporal } from './testing/temporal-test-env.js';
import type { readiesModel } from './testing/model-ready.fixture-workflow.js';
import { testWorker } from './testing/test-worker.js';
import { NO_SETUP } from './testing/no-cluster-setup.js';


const k3s = await privateCluster(import.meta.filename);
const access = new ClusterAccess({ here: { koalaMachineId: 'dev1', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-model-ready-')), processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: k3s.account });
const DESK: Reach = startedMachine('machine-desk', k3s.admin);

let env: TestTemporal;
let standIn: HuggingFaceStandIn;

beforeAll(async () => {
  env = await temporalTestEnvironment();
  standIn = await startHuggingFaceStandIn(access, DESK);
});

afterAll(async () => {
  await standIn.stop();
  await env.teardown();
  await k3s.stop();
}, 0);

const worker = async (taskQueue: string) => testWorker(env, {
  namespace: env.namespace ?? 'default',
  taskQueue,
  workflowBundle: await bundled(resolve(import.meta.dirname, 'testing/model-ready.fixture-workflow.ts')),
  activities: clusterActivities({ access } as unknown as ClusterSteps, NO_SETUP, standIn.endpoint),
});

describe('a model app\'s workflows with the cluster worker\'s own activities, on a real cluster', () => {
  it('ready a model by downloading it on the machine that runs it', async () => {
    const taskQueue = `model-ready-${Math.random().toString(36).slice(2, 8)}`;
    const ready = await (await worker(taskQueue)).runUntil(env.client.workflow.execute<typeof readiesModel>('readiesModel', {
      taskQueue, workflowId: `readies-${taskQueue}`,
      args: [{ appType: 'vllm', clusterId: DESK.clusterId, reach: DESK, vllmModel: 'acme/tiny', modelImage: STAND_IN_IMAGE, modelCacheHostPath: `/var/lib/rancher/koala-test-ready-${taskQueue}` }],
    }));
    expect(ready).toBe(true);
  });

  it('stop a vLLM deploy at the GPU check on a machine without NVIDIA\'s CDI support, saying what to do', async () => {
    const taskQueue = `model-gpu-${Math.random().toString(36).slice(2, 8)}`;
    const failed = await (await worker(taskQueue)).runUntil(env.client.workflow.execute('executeDeployAppWorkflow', {
      taskQueue, workflowId: `deploys-${taskQueue}`,
      args: [{ name: 'llm', clusterId: DESK.clusterId, reach: DESK, clusterName: 'desk', appType: 'vllm', vllmGpuCount: 1, vllmGpuVendor: 'nvidia', strategy: 'native', modules: [], logFile: join(tmpdir(), `${taskQueue}.log`) }],
    })).then(() => undefined, (err: unknown) => err);
    try {
      expect(failed).toBeInstanceOf(WorkflowFailedError);
      let at = failed as { message?: string; cause?: unknown };
      while (at.cause) at = at.cause as { message?: string; cause?: unknown };
      expect(at.message).toMatch(/the NVIDIA device plugin cannot run on desk: .*install NVIDIA's CDI support \(the NVIDIA Container Toolkit\), restart k3s there once it is installed, then deploy again\./s);
    } finally {
      await access.kubectl(DESK, ['delete', 'daemonset', 'nvidia-device-plugin-daemonset', '-n', 'kube-system', '--ignore-not-found', '--wait=false']);
    }
  });

  it('stop a change of a vLLM app\'s model that Hugging Face does not have before anything is applied, saying so', async () => {
    const taskQueue = `model-sync-${Math.random().toString(36).slice(2, 8)}`;
    const failed = await (await worker(taskQueue)).runUntil(env.client.workflow.execute('executeSyncConfigWorkflow', {
      taskQueue, workflowId: `syncs-${taskQueue}`,
      args: [{ name: 'llm', namespace: 'llm-1a2b3c', clusterId: DESK.clusterId, reach: DESK, clusterName: 'desk', strategy: 'native', appType: 'vllm', vllmModel: 'acme/unknown', vllmGpuCount: 0, modelImage: STAND_IN_IMAGE, modelCacheHostPath: `/var/lib/rancher/koala-test-sync-${taskQueue}`, deploymentId: 'd1', storage: {}, logFile: join(tmpdir(), `${taskQueue}.log`) }],
    })).then(() => undefined, (err: unknown) => err);
    expect(failed).toBeInstanceOf(WorkflowFailedError);
    let at = failed as { message?: string; cause?: unknown };
    while (at.cause) at = at.cause as { message?: string; cause?: unknown };
    expect(at.message).toMatch(/Hugging Face answered 404/);
    expect((await access.kubectl(DESK, ['get', 'namespace', 'llm-1a2b3c', '--ignore-not-found', '-o', 'name'])).trim()).toBe('');
  });
});
