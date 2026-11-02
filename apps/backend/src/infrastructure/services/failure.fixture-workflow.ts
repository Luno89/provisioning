import { ApplicationFailure, condition } from '@temporalio/workflow';

export async function RemoveProjectWorkflow(): Promise<void> {
  throw ApplicationFailure.nonRetryable('the project\'s cluster could not be reached');
}

export async function waitsToBeCancelled(): Promise<void> {
  await condition(() => false);
}
