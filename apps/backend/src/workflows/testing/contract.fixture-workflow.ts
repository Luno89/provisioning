import { ApplicationFailure, CancellationScope, condition, continueAsNew, defineSignal, executeChild, isCancellation, patched, proxyActivities, setHandler } from '@temporalio/workflow';

const { flaky, refuses } = proxyActivities<{ flaky(): Promise<number>; refuses(): Promise<void> }>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '10 ms', maximumAttempts: 5 },
});

export const told = defineSignal<[string]>('told');

export async function child(word: string): Promise<string> {
  return `${word} from the child`;
}

export async function parent(): Promise<string> {
  return executeChild(child, { args: ['hello'] });
}

export async function counts(to: number, at = 0): Promise<number> {
  if (at < to) await continueAsNew<typeof counts>(to, at + 1);
  return at;
}

export async function listens(): Promise<string[]> {
  const heard: string[] = [];
  setHandler(told, (word) => { heard.push(word); });
  await condition(() => heard.length === 2);
  return heard;
}

export async function waitsToBeStopped(): Promise<string> {
  try {
    await CancellationScope.current().cancelRequested;
    return 'never';
  } catch (err) {
    if (isCancellation(err)) return 'stopped';
    throw err;
  }
}

export async function retries(): Promise<number> {
  return flaky();
}

export async function stopsRetrying(): Promise<string> {
  try {
    await refuses();
    return 'went on';
  } catch (err) {
    return (err as { cause?: { message?: string } }).cause?.message ?? 'no cause';
  }
}

export async function patchedOrNot(): Promise<boolean> {
  return patched('contract-patch');
}

export async function failsForGood(): Promise<void> {
  throw ApplicationFailure.nonRetryable('this cannot work');
}
