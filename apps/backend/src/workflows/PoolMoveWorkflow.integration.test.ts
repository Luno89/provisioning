import { describe, it, expect } from 'vitest';
import { timeSkippingClient } from '@koala/engine-core/testing/temporal';
import { MOVE_FINISHED, MOVE_STOPPED, poolMoveWorkflowId } from '../instances/lib/instance-move.js';
import { temporalTestEnvironment } from './testing/temporal-test-env.js';
import { environmentForFile, testWorker, uniqueName } from './testing/test-worker.js';
import type { PoolMoveWorkflow } from './PoolMoveWorkflow.js';
import { failureReason } from '../platform/lib/temporal-failure.js';

const file = environmentForFile(temporalTestEnvironment);

const run = async (signal: (handle: { signal: (name: string, ...args: unknown[]) => Promise<void> }) => Promise<void>, start: () => Promise<void> = async () => undefined) => {
  const seen: string[] = [];
  const { env } = file;
  const taskQueue = uniqueName('pool-move-test');
  const worker = await testWorker(env, {
    taskQueue,
    workflows: 'PoolMoveWorkflow.ts',
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
    return timeSkippingClient(env).result(handle.workflowId).catch((error: unknown) => `failed: ${failureReason('FAILED', error)}`);
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
