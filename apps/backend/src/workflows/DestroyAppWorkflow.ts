import { proxyActivities } from '@temporalio/workflow';
import type { DestroyAppArgs, DestroyAppResult } from '../activities/DestroyAppActivity.js';
import { destroyAppActivityMeta } from '../lib/activity-timeouts.js';
import { DESTROY_RETRY } from '../lib/activity-retry.js';

const { DestroyAppActivity } = proxyActivities<{ DestroyAppActivity: (args: DestroyAppArgs) => Promise<DestroyAppResult> }>({ retry: DESTROY_RETRY, startToCloseTimeout: destroyAppActivityMeta.startToCloseTimeout });

export async function executeDestroyAppWorkflow(args: DestroyAppArgs) {
  return DestroyAppActivity(args);
}
