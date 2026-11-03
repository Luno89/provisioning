import { ActivityCancellationType, CancellationScope, defineSignal, isCancellation, proxyActivities, setHandler } from '@temporalio/workflow';

export const stop = defineSignal('stop');

const { holdUntilStopped } = proxyActivities<{ holdUntilStopped(): Promise<void> }>({
  startToCloseTimeout: '1 hour',
  heartbeatTimeout: '1 minute',
  cancellationType: ActivityCancellationType.TRY_CANCEL,
});

export async function stoppableRun(): Promise<string> {
  const scope = new CancellationScope();
  setHandler(stop, () => scope.cancel());
  try {
    await scope.run(() => holdUntilStopped());
    return 'finished';
  } catch (err) {
    if (isCancellation(err)) return 'stopped';
    throw err;
  }
}
