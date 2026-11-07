import { Context } from '@temporalio/activity';
import { ActivityFailure, CancelledFailure, TimeoutFailure, WorkflowFailedError } from '@temporalio/client';
import { TimeoutType } from '@temporalio/common';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, type ActivityInterceptorsFactory } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heartbeatWhileRunning, WORKER_DEFAULTS } from './liveness.js';
import { queueFor, temporal, workflowBundle } from '../testing/temporal.js';
import { silentFor, stop, stoppedWhileRunning } from '../testing/workflows.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporal();
});

afterAll(async () => {
  await env.teardown();
});

const released = () => {
  let release!: (why: string) => void;
  const waiting = new Promise<string>((resolve) => { release = resolve; });
  return { release, waiting };
};

async function working<T>(interceptors: ActivityInterceptorsFactory[], activityRuns: Promise<string> | undefined, test: (taskQueue: string) => Promise<T>, started: () => void = () => {}): Promise<T> {
  const taskQueue = queueFor('liveness');
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: await workflowBundle(),
    ...WORKER_DEFAULTS,
    interceptors: { activity: interceptors },
    activities: {
      async waitForStop(): Promise<string> {
        started();
        const heard = Context.current().cancelled.then(
          () => 'it was never stopped',
          (err: unknown) => (err instanceof CancelledFailure ? `heard the stop: ${err.message}` : Promise.reject(err)),
        );
        return Promise.race([heard, ...(activityRuns ? [activityRuns] : [])]);
      },
      echo: async (value: unknown) => value,
    },
  });
  return worker.runUntil(test(taskQueue));
}

describe('an activity that never beats its own heart', () => {
  it('hears that its workflow stopped it, because the interceptor beats for it while it runs', async () => {
    const running = released();
    const said = await working([heartbeatWhileRunning()], undefined, async (taskQueue) => {
      const handle = await env.client.workflow.start(stoppedWhileRunning, { taskQueue, workflowId: queueFor('stopped'), args: ['3s'] });
      await running.waiting;
      await handle.signal(stop);
      return handle.result();
    }, () => running.release('the activity runs'));

    expect(said).toBe('heard the stop: CANCELLED');
  });

  it('is timed out by Temporal once nothing beats for it', async () => {
    const left = released();

    const failure = await working([], left.waiting, async (taskQueue) => {
      const handle = await env.client.workflow.start(silentFor, { taskQueue, workflowId: queueFor('silent'), args: ['1s'] });
      return handle.result().catch((err: unknown) => err).finally(() => left.release('let go once the workflow failed'));
    });

    expect(failure).toBeInstanceOf(WorkflowFailedError);
    const cause = (failure as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ActivityFailure);
    expect((cause as ActivityFailure).cause).toBeInstanceOf(TimeoutFailure);
    expect(((cause as ActivityFailure).cause as TimeoutFailure).timeoutType).toBe(TimeoutType.HEARTBEAT);
  });
});
