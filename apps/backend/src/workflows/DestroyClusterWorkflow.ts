/**
 * DestroyClusterWorkflow
 *
 * Orchestrates the lifecycle of a cluster destruction: triggers
 * DestroyClusterActivity and waits for completion.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { DestroyClusterArgs } from '../activities/DestroyClusterActivity.js';

const { DestroyClusterActivity } = proxyActivities<{ DestroyClusterActivity: DestroyClusterArgs }>({ startToCloseTimeout: '30 minutes' });

export async function executeDestroyClusterWorkflow(args: DestroyClusterArgs) {
  const result = await DestroyClusterActivity(args);
  return result;
}
