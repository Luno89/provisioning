import { ApplicationFailure, condition } from '@temporalio/workflow';

export async function deploys(outcome: 'healthy' | 'fails'): Promise<{ workload: string }> {
  if (outcome === 'fails') throw ApplicationFailure.nonRetryable('the app did not come up');
  return { workload: 'healthy' };
}

export async function waitsToBeCancelled(): Promise<void> {
  await condition(() => false);
}
