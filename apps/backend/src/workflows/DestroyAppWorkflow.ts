import { proxyActivities } from '@temporalio/workflow';
import type { DestroyAppArgs, DestroyAppResult } from '../activities/DestroyAppActivity.js';
import { LIVE_ACTIVITY } from '../lib/activity-liveness.js';
import { DESTROY_RETRY } from '../lib/activity-retry.js';

const { DestroyAppActivity } = proxyActivities<{ DestroyAppActivity: (args: DestroyAppArgs) => Promise<DestroyAppResult> }>({ retry: DESTROY_RETRY, ...LIVE_ACTIVITY });

export async function executeDestroyAppWorkflow(args: DestroyAppArgs) {
  return DestroyAppActivity(args);
}
