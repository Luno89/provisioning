import { WORKER_DEFAULTS, activityInterceptors } from '@koala/engine-core';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { bundled, clockSkippingEnvironment } from './temporal-test-env.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { failureReason } from '../platform/lib/temporal-failure.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let env: TestWorkflowEnvironment;

beforeAll(async () => { env = await clockSkippingEnvironment(); });
afterAll(async () => { await env?.teardown(); });

const remove = async (step: () => Promise<void>): Promise<string> => {
  const taskQueue = `pool-remove-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({
    ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue,
    workflowBundle: await bundled(resolve(__dirname, 'PoolRemoveWorkflow.ts')),
    activities: { PoolRemoveActivity: step },
  });
  return worker.runUntil(env.client.workflow.execute('PoolRemoveWorkflow', { workflowId: `pool-remove-${taskQueue}`, taskQueue, args: [{ instanceId: 'inst-1' }], ...startedFor('u1') })
    .then(() => 'removed', (error: unknown) => `failed: ${failureReason('FAILED', error)}`));
};

describe('removing a pool instance', () => {
  it('keeps removing while the pool cannot be reached, however many tries that takes', async () => {
    let tries = 0;
    expect(await remove(async () => {
      tries += 1;
      if (tries <= 11) throw Object.assign(new Error('connect ECONNREFUSED 10.43.0.1:443'), { code: 'ECONNREFUSED' });
    })).toBe('removed');
    expect(tries).toBe(12);
  });

  it('stops at once with why when removing fails for good', async () => {
    let tries = 0;
    expect(await remove(async () => { tries += 1; throw new Error('the vcluster koala-inst-1 is not the pool\'s'); })).toBe('failed: the vcluster koala-inst-1 is not the pool\'s');
    expect(tries).toBe(1);
  });
});
