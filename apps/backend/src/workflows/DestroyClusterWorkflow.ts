import { proxyActivities } from '@temporalio/workflow';
import type { DestroyClusterArgs, DestroyClusterResult } from '../activities/DestroyClusterActivity.js';
import { LIVE_ACTIVITY } from '../lib/activity-liveness.js';

const { DestroyClusterActivity } = proxyActivities<{ DestroyClusterActivity: (args: DestroyClusterArgs) => Promise<DestroyClusterResult> }>({
  ...LIVE_ACTIVITY,
  retry: { maximumAttempts: 5 },
});

export async function executeDestroyClusterWorkflow(args: DestroyClusterArgs) {
  const result = await DestroyClusterActivity(args);
  return result;
}
