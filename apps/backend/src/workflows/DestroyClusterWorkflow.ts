import { proxyActivities } from '@temporalio/workflow';
import type { DestroyClusterArgs, DestroyClusterResult } from '../activities/DestroyClusterActivity.js';
import { destroyClusterActivityMeta } from '../lib/activity-timeouts.js';

const { DestroyClusterActivity } = proxyActivities<{ DestroyClusterActivity: (args: DestroyClusterArgs) => Promise<DestroyClusterResult> }>({
  startToCloseTimeout: destroyClusterActivityMeta.startToCloseTimeout,
  retry: { maximumAttempts: 5 },
});

export async function executeDestroyClusterWorkflow(args: DestroyClusterArgs) {
  const result = await DestroyClusterActivity(args);
  return result;
}
