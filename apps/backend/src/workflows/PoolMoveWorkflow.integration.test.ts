import { activityInterceptors } from '@koala/engine-core';
import { WORKER_DEFAULTS } from '@koala/engine-core';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment, TimeSkippingWorkflowClient } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { MOVE_FINISHED, MOVE_STOPPED, poolMoveWorkflowId } from '../instances/lib/instance-move.js';
import { bundled, temporalTestEnvironment } from './testing/temporal-test-env.js';
import type { PoolMoveWorkflow } from './PoolMoveWorkflow.js';
import { failureReason } from '../platform/lib/temporal-failure.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let env: TestWorkflowEnvironment;

beforeAll(async () => { env = await temporalTestEnvironment(); });
afterAll(async () => { await env?.teardown(); });

const run = async (signal: (handle: { signal: (name: string, ...args: unknown[]) => Promise<void> }) => Promise<void>, start: () => Promise<void> = async () => undefined) => {
  const seen: string[] = [];
  const taskQueue = `pool-move-test-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({
    interceptors: { activity: activityInterceptors() },
    ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default',
    taskQueue,
    workflowBundle: await bundled(resolve(__dirname, 'PoolMoveWorkflow.ts')),
    activities: {
      PoolMoveStartActivity: async () => { await start(); seen.push('start'); },
      PoolMoveSwitchActivity: async () => { seen.push('switch'); return { name: 'bo' }; },
      PoolMoveStopActivity: async ({ reason }: { reason: string }) => { seen.push(`stop: ${reason}`); },
    },
  });
  const result = await worker.runUntil(async () => {
    const handle = await env.client.workflow.start<typeof PoolMoveWorkflow>('PoolMoveWorkflow', {
      workflowId: poolMoveWorkflowId('inst-bo'), taskQueue, args: [{ instanceId: 'inst-bo' }], searchAttributes: { KoalaOwner: ['bo'] },
    });
    await signal({ signal: (name, ...args) => handle.signal(name, ...args) });
    return new TimeSkippingWorkflowClient({ connection: env.connection, namespace: env.namespace ?? 'default' }).result(handle.workflowId).catch((error: unknown) => `failed: ${failureReason('FAILED', error)}`);
  });
  return { seen, result };
};

describe('one move of a pool instance', () => {
  it('switches over once the new machine has everything', async () => {
    const { seen, result } = await run((handle) => handle.signal(MOVE_FINISHED));
    expect(seen).toEqual(['start', 'switch']);
    expect(result).toBe('moved');
  });

  it('stops, keeping the pool copy, when the move fails or the person stops it', async () => {
    const { seen, result } = await run((handle) => handle.signal(MOVE_STOPPED, 'you stopped the move'));
    expect(seen).toEqual(['start', 'stop: you stopped the move']);
    expect(result).toBe('stopped');
  });

  it('keeps starting the move while the machine cannot be reached, however many tries that takes', async () => {
    let tries = 0;
    const { seen, result } = await run((handle) => handle.signal(MOVE_FINISHED), async () => {
      tries += 1;
      if (tries <= 11) throw Object.assign(new Error('connect ECONNREFUSED 100.64.0.7:6443'), { code: 'ECONNREFUSED' });
    });
    expect(tries).toBe(12);
    expect(seen).toEqual(['start', 'switch']);
    expect(result).toBe('moved');
  });

  it('stops at once with why when starting the move fails for good', async () => {
    let tries = 0;
    const { seen, result } = await run(async () => undefined, async () => {
      tries += 1;
      throw new Error('the machine bo-desk is no longer bo\'s');
    });
    expect(tries).toBe(1);
    expect(seen).toEqual([]);
    expect(result).toBe('failed: the machine bo-desk is no longer bo\'s');
  });
});
