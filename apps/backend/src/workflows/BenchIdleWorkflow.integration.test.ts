import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { BenchIdleWorkflow, benchActivitySignal } from './BenchIdleWorkflow.js';
import { DEFAULT_STREAM_TASK_QUEUE, type BenchIdleOutcome } from '../engine-host/temporal/contracts.js';
import { bundled, worldPerTest } from './testing/temporal-test-env.js';
import { testWorker } from './testing/test-worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;

const temporal = worldPerTest();

async function scenario(answers: BenchIdleOutcome[], drive: (signal: (idleMs: number) => Promise<void>, asked: string[]) => Promise<void>) {
  const taskQueue = `bench-test-${Math.random().toString(36).slice(2, 8)}`;
  const asked: string[] = [];
  const timers = await testWorker(temporal.env, { namespace: temporal.world.namespace, taskQueue, workflowBundle: await bundled(resolve(__dirname, 'BenchIdleWorkflow.ts')) });
  const backend = await testWorker(temporal.env, {
    namespace: temporal.world.namespace,
    taskQueue: DEFAULT_STREAM_TASK_QUEUE,
    activities: { EngineBenchIdleActivity: async ({ ownerId }: { ownerId: string }) => { asked.push(ownerId); return answers.shift() ?? 'nothing'; } },
  });
  await timers.runUntil(() => backend.runUntil(async () => {
    const signal = async (idleMs: number) => {
      await temporal.world.client.workflow.signalWithStart(BenchIdleWorkflow, { workflowId: `bench-idle-${taskQueue}`, taskQueue, args: [{ ownerId: 'u1' }], signal: benchActivitySignal, signalArgs: [{ idleMs }] });
    };
    await drive(signal, asked);
  }));
}

describe('the bench\'s idle countdown', () => {
  it('asks the backend only once the model has been idle for the whole time since the last run event', async () => {
    await scenario(['started'], async (signal, asked) => {
      await signal(15 * MINUTE);
      await temporal.env.sleep(10 * MINUTE);
      await signal(15 * MINUTE);
      await temporal.env.sleep(10 * MINUTE);
      expect(asked, 'it fired before fifteen idle minutes had passed since the last run event').toEqual([]);
      await temporal.env.sleep(10 * MINUTE);
      expect(asked).toEqual(['u1']);
    });
  });

  it('when the model turns out to be busy, waits for the next run event instead of polling', async () => {
    await scenario(['busy', 'started'], async (signal, asked) => {
      await signal(15 * MINUTE);
      await temporal.env.sleep(16 * MINUTE);
      expect(asked).toEqual(['u1']);
      await temporal.env.sleep(60 * MINUTE);
      expect(asked, 'it asked again with no new run event').toEqual(['u1']);
      await signal(15 * MINUTE);
      await temporal.env.sleep(16 * MINUTE);
      expect(asked).toEqual(['u1', 'u1']);
    });
  });
});
