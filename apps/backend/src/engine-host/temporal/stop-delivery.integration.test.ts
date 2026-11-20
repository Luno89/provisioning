import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Context } from '@temporalio/activity';
import { Worker } from '@temporalio/worker';
import { STOPS_ARRIVE_WITHIN_MS } from '@koala/engine-core';
import { bundled, temporalTestEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { testWorker } from '../../workflows/testing/test-worker.js';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import type { TestTemporal } from '@koala/engine-core/testing/temporal';

const QUEUE = 'stop-delivery-test';
let env: TestTemporal;
let worker: Worker;
let running: Promise<void>;
let startedAt = 0;
let heardAt = 0;

beforeAll(async () => {
  env = await temporalTestEnvironment();
  worker = await testWorker(env, {
    taskQueue: QUEUE,
    workflowBundle: await bundled(resolve(__dirname, 'testing/stop-delivery.fixture-workflow.ts')),
    maxHeartbeatThrottleInterval: STOPS_ARRIVE_WITHIN_MS,
    activities: {
      async holdUntilStopped(): Promise<void> {
        startedAt = Date.now();
        const signal = Context.current().cancellationSignal;
        await new Promise<void>((_done, failed) => {
          signal.addEventListener('abort', () => {
            heardAt = Date.now();
            failed(signal.reason as Error);
          });
        });
      },
    },
  });
  running = worker.run();
});

afterAll(async () => {
  worker?.shutdown();
  await running;
  await env?.teardown();
});

describe('a run stopped in the middle of a long step', () => {
  it('reaches the step through its heartbeats within the bound the workers set, long after the first one went out', async () => {
    const handle = await env.client.workflow.start('stoppableRun', { taskQueue: QUEUE, workflowId: 'stop-delivery-1', ...startedFor('owner-1') });
    while (startedAt === 0) await new Promise((done) => setTimeout(done, 50));
    await new Promise((done) => setTimeout(done, 5_000));
    const stoppedAt = Date.now();
    await handle.signal('stop');
    expect(await handle.result()).toBe('stopped');
    while (heardAt === 0) await new Promise((done) => setTimeout(done, 50));
    expect(heardAt - stoppedAt).toBeLessThanOrEqual(STOPS_ARRIVE_WITHIN_MS + 1_000);
  });
});
