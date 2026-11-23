import type { Duration } from '@temporalio/common';
import { ActivityCancellationType, CancellationScope, condition, defineSignal, isCancellation, proxyActivities, setHandler } from '@temporalio/workflow';

export interface TestActivities {
  waitForStop(): Promise<string>;
  echo(value: unknown): Promise<unknown>;
  fails(kind: string, until: number): Promise<number>;
}

export const stop = defineSignal('stop');

export async function stoppedWhileRunning(heartbeatTimeout: Duration): Promise<string> {
  const { waitForStop } = proxyActivities<TestActivities>({
    startToCloseTimeout: '30 days',
    heartbeatTimeout,
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });
  let stopping = false;
  setHandler(stop, () => { stopping = true; });
  const scope = new CancellationScope();
  const running = scope.run(() => waitForStop());
  await condition(() => stopping);
  scope.cancel();
  return running;
}

export async function cancelledBeforeItStarted(activityQueue: string): Promise<string> {
  const { waitForStop } = proxyActivities<TestActivities>({
    taskQueue: activityQueue,
    startToCloseTimeout: '30 days',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });
  let stopping = false;
  setHandler(stop, () => { stopping = true; });
  const scope = new CancellationScope();
  const running = scope.run(() => waitForStop());
  await condition(() => stopping);
  scope.cancel();
  return running.then(() => 'it ran', (err: unknown) => (isCancellation(err) ? 'cancelled before it started' : `it failed: ${(err as Error).message}`));
}

export async function silentFor(heartbeatTimeout: Duration): Promise<string> {
  const { waitForStop } = proxyActivities<TestActivities>({
    startToCloseTimeout: '30 days',
    heartbeatTimeout,
    retry: { maximumAttempts: 1 },
  });
  return waitForStop();
}

export async function echoed(value: unknown): Promise<unknown> {
  const { echo } = proxyActivities<TestActivities>({ startToCloseTimeout: '30 days', retry: { maximumAttempts: 1 } });
  return echo(value);
}

export async function failingUntil(kind: string, until: number, interval: Duration): Promise<number> {
  const { fails } = proxyActivities<TestActivities>({
    startToCloseTimeout: '30 days',
    retry: { initialInterval: interval, backoffCoefficient: 2, maximumInterval: interval },
  });
  return fails(kind, until);
}
