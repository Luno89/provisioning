import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { WorkflowFailedError } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { temporalTestEnvironment } from './temporal-test-env.js';
import type { ProvisionClusterResult } from '../activities/ProvisionClusterActivity.js';
import { clusterFieldsFrom } from '../infrastructure/lib/provisioned-cluster.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let env: TestWorkflowEnvironment;

beforeAll(async () => { env = await temporalTestEnvironment(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

const provision = async (activity: () => Promise<ProvisionClusterResult>) => {
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
    return handle.result().then((result: Awaited<ReturnType<typeof import('./ClusterProvisionWorkflow.js').ClusterProvisionWorkflow>>) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
  });
  return { attempts, ...outcome };
};

describe('provisioning a cluster', () => {
  it('ends healthy with the kubeconfig and capacity the activity found', async () => {
    const { attempts, result } = await provision(async () => ({ status: 'healthy', kubeconfigPath: '/tmp/kubeconfig-shop', msg: 'Cluster shop provisioned', logFile: '/tmp/shop.log', capacity: { cpuCores: 4, ramGb: 8 } }));
    expect(attempts).toBe(1);
    expect(result).toMatchObject({ status: 'healthy', kubeconfig: '/tmp/kubeconfig-shop', capacity: { cpuCores: 4, ramGb: 8 } });
  });

  it('hands on everything the activity made, so the cluster records its server, its mesh address and how to reach it', async () => {
    const made: Required<ProvisionClusterResult> = {
      status: 'healthy',
      kubeconfigPath: '/tmp/kubeconfig-shop',
      msg: 'Cluster shop provisioned',
      logFile: '/tmp/shop.log',
      hetznerServerId: '',
      doServerId: 'droplet-42',
      createdHost: '203.0.113.9',
      createdUsername: 'root',
      createdPrivateKey: 'the key',
      meshIp: '100.64.0.7',
      capacity: { cpuCores: 2, ramGb: 4 },
    };
    const { result } = await provision(async () => made);
    expect(clusterFieldsFrom(result!, (secret) => `sealed(${secret})`)).toEqual({
      meshIp: '100.64.0.7',
      capacity: { cpuCores: 2, ramGb: 4 },
      remoteHost: '203.0.113.9',
      remoteUsername: 'root',
      remoteSshPrivateKeyEnc: 'sealed(the key)',
      doServerId: 'droplet-42',
    });
  });

  it('fails as a workflow when its stack never deploys, so the cluster is never called healthy', async () => {
    const { attempts, error } = await provision(async () => { throw new Error('chart requires kubeVersion: >=1.30.0-0'); });
    expect(attempts).toBe(3);
    expect(error).toBeInstanceOf(WorkflowFailedError);
  }, 60_000);
});
