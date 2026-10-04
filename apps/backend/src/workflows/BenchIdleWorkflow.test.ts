import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { BenchIdleWorkflow, benchActivitySignal } from './BenchIdleWorkflow.js';
import { DEFAULT_STREAM_TASK_QUEUE, type BenchIdleOutcome } from '../engine-host/temporal/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

async function scenario(answers: BenchIdleOutcome[], drive: (signal: (idleMs: number) => Promise<void>, asked: string[]) => Promise<void>) {
  const taskQueue = `bench-test-${Math.random().toString(36).slice(2, 8)}`;
  const asked: string[] = [];
  const timers = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: resolve(__dirname, 'BenchIdleWorkflow.ts') });
  const backend = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: DEFAULT_STREAM_TASK_QUEUE,
    activities: { EngineBenchIdleActivity: async ({ ownerId }: { ownerId: string }) => { asked.push(ownerId); return answers.shift() ?? 'nothing'; } },
  });
  await timers.runUntil(() => backend.runUntil(async () => {
    const signal = async (idleMs: number) => {
      await env.client.workflow.signalWithStart(BenchIdleWorkflow, { workflowId: `bench-idle-${taskQueue}`, taskQueue, args: [{ ownerId: 'u1' }], signal: benchActivitySignal, signalArgs: [{ idleMs }] });
    };
    await drive(signal, asked);
  }));
}

describe('the bench\'s idle countdown', () => {
  it('asks the backend only once the model has been idle for the whole time since the last run event', async () => {
    await scenario(['started'], async (signal, asked) => {
      await signal(15 * MINUTE);
      await env.sleep(10 * MINUTE);
      await signal(15 * MINUTE);
      await env.sleep(10 * MINUTE);
      expect(asked, 'it fired before fifteen idle minutes had passed since the last run event').toEqual([]);
      await env.sleep(10 * MINUTE);
      expect(asked).toEqual(['u1']);
    });
  }, 120_000);

  it('when the model turns out to be busy, waits for the next run event instead of polling', async () => {
    await scenario(['busy', 'started'], async (signal, asked) => {
      await signal(15 * MINUTE);
      await env.sleep(16 * MINUTE);
      expect(asked).toEqual(['u1']);
      await env.sleep(60 * MINUTE);
      expect(asked, 'it asked again with no new run event').toEqual(['u1']);
      await signal(15 * MINUTE);
      await env.sleep(16 * MINUTE);
      expect(asked).toEqual(['u1', 'u1']);
    });
  }, 120_000);
});
