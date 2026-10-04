import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import { DEFAULT_STREAM_TASK_QUEUE, type BenchIdleOutcome } from '../engine-host/temporal/contracts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

export const benchActivitySignal = defineSignal<[{ idleMs: number }]>('benchActivity');

const { EngineBenchIdleActivity } = proxyActivities<{ EngineBenchIdleActivity(args: { ownerId: string }): Promise<BenchIdleOutcome> }>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: '1 minute',
});

export async function BenchIdleWorkflow(input: { ownerId: string }): Promise<BenchIdleOutcome> {
  let idleMs = 0;
  let changes = 0;
  setHandler(benchActivitySignal, ({ idleMs: after }) => { idleMs = after; changes += 1; });

  for (;;) {
    await condition(() => idleMs > 0);
    const seen = changes;
    if (await condition(() => changes !== seen, idleMs)) continue;
    const outcome = await EngineBenchIdleActivity({ ownerId: input.ownerId });
    if (outcome !== 'busy') return outcome;
    const waiting = changes;
    await condition(() => changes !== waiting);
  }
}
