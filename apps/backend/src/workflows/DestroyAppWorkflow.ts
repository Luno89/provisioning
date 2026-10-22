import { proxyActivities } from '@temporalio/workflow';
import type { DestroyAppArgs, DestroyAppResult } from '../activities/DestroyAppActivity.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { DESTROY_RETRY } from '../platform/lib/activity-retry.js';

const { DestroyAppActivity } = proxyActivities<{ DestroyAppActivity: (args: DestroyAppArgs) => Promise<DestroyAppResult> }>({ retry: DESTROY_RETRY, ...LIVE_ACTIVITY });

export async function executeDestroyAppWorkflow(args: DestroyAppArgs) {
  return DestroyAppActivity(args);
}
