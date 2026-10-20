import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { MOVE_FINISHED, MOVE_STOPPED, poolMoveWorkflowId } from '../lib/instance-move.js';
import { temporalTestEnvironment } from './temporal-test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let env: TestWorkflowEnvironment;

beforeAll(async () => { env = await temporalTestEnvironment(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

const run = async (signal: (handle: { signal: (name: string, ...args: unknown[]) => Promise<void> }) => Promise<void>) => {
  const seen: string[] = [];
  const taskQueue = `pool-move-test-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: resolve(__dirname, 'PoolMoveWorkflow.ts'),
    activities: {
      PoolMoveStartActivity: async () => { seen.push('start'); },
      PoolMoveSwitchActivity: async () => { seen.push('switch'); return { name: 'bo' }; },
      PoolMoveStopActivity: async ({ reason }: { reason: string }) => { seen.push(`stop: ${reason}`); },
    },
  });
  const result = await worker.runUntil(async () => {
    const handle = await env.client.workflow.start('PoolMoveWorkflow', {
      workflowId: poolMoveWorkflowId('inst-bo'), taskQueue, args: [{ instanceId: 'inst-bo' }], searchAttributes: { KoalaOwner: ['bo'] },
    });
    await signal(handle as never);
    return handle.result();
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
});
