import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ROOT_REMOVAL_WORKFLOW, removeAccountWorkflowId } from '../lib/account-removal.js';
import { temporalTestEnvironment } from './temporal-test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const run = async (poolInstanceId: string | undefined) => {
  const seen: string[] = [];
  const taskQueue = `root-removal-test-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: resolve(__dirname, 'RootAccountRemovalWorkflow.ts'),
    activities: {
      RootRemovalInstanceActivity: async () => { seen.push('find instance'); return poolInstanceId ? { poolInstanceId } : {}; },
      PoolRemoveActivity: async ({ instanceId }: { instanceId: string }) => { seen.push(`remove pool instance ${instanceId}`); },
      RootRemovalMeshActivity: async () => { seen.push('mesh'); return { devices: 2, user: true }; },
      RootRemovalRecordsActivity: async () => { seen.push('records'); return { users: 1, instances: 1 }; },
    },
  });
  const result = await worker.runUntil(env.client.workflow.execute(ROOT_REMOVAL_WORKFLOW, {
    workflowId: removeAccountWorkflowId('bo'), taskQueue, args: [{ ownerId: 'bo' }], searchAttributes: { KoalaOwner: ['bo'] },
  }));
  return { seen, result };
};

describe('removing an account on root', () => {
  it('deletes a pool instance with everything in it before its machines leave the mesh and its records go', async () => {
    const { seen, result } = await run('inst-1');
    expect(seen).toEqual(['find instance', 'remove pool instance inst-1', 'mesh', 'records']);
    expect(result).toEqual({ poolInstance: true, meshDevices: 2, records: { users: 1, instances: 1 } });
  });

  it('unregisters an instance on the person\'s own machine by removing its mesh user and its record', async () => {
    const { seen } = await run(undefined);
    expect(seen).toEqual(['find instance', 'mesh', 'records']);
  });
});
