import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { WorkflowFailedError } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { temporalTestEnvironment } from './temporal-test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let env: TestWorkflowEnvironment;

beforeAll(async () => { env = await temporalTestEnvironment(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

const provision = async (activity: () => Promise<unknown>) => {
  let attempts = 0;
  const taskQueue = `cluster-provision-test-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: resolve(__dirname, 'ClusterProvisionWorkflow.ts'),
    activities: { ProvisionClusterActivity: async () => { attempts += 1; return activity(); } },
  });
  const outcome = await worker.runUntil(async () => {
    const handle = await env.client.workflow.start('ClusterProvisionWorkflow', {
      workflowId: `cluster-provision-test-${Math.random().toString(36).slice(2, 8)}`,
      taskQueue,
      args: [{ name: 'shop', provider: 'k3d', logFile: '/tmp/shop.log' }],
      searchAttributes: { KoalaOwner: ['bo'] },
    });
    return handle.result().then((result: unknown) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
  });
  return { attempts, ...outcome };
};

describe('provisioning a cluster', () => {
  it('ends healthy with the kubeconfig and capacity the activity found', async () => {
    const { attempts, result } = await provision(async () => ({ status: 'healthy', kubeconfigPath: '/tmp/kubeconfig-shop', msg: 'Cluster shop provisioned', capacity: { cpu: 4 } }));
    expect(attempts).toBe(1);
    expect(result).toMatchObject({ status: 'healthy', kubeconfig: '/tmp/kubeconfig-shop', capacity: { cpu: 4 } });
  });

  it('fails as a workflow when its stack never deploys, so the cluster is never called healthy', async () => {
    const { attempts, error } = await provision(async () => { throw new Error('chart requires kubeVersion: >=1.30.0-0'); });
    expect(attempts).toBe(3);
    expect(error).toBeInstanceOf(WorkflowFailedError);
  }, 60_000);
});
