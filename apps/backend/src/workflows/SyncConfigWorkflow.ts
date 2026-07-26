/**
 * SyncConfigWorkflow - orchestrates re-applying a deployment's current config + restart.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { SyncConfigArgs } from '../activities/SyncConfigActivity.js';
// From lib/activity-timeouts.ts, not the activity file directly — see AppDeployWorkflow.ts for
// why (a value import from an activity file breaks Temporal's webpack workflow bundling).
import { syncConfigActivityMeta } from '../lib/activity-timeouts.js';

// syncConfigActivityMeta.startToCloseTimeout, not a hardcoded '30 minutes' — see
// AppDeployWorkflow.ts for why (this activity declares 80 min).
const { SyncConfigActivity } = proxyActivities<{ SyncConfigActivity: SyncConfigArgs }>({ startToCloseTimeout: syncConfigActivityMeta.startToCloseTimeout });

export async function executeSyncConfigWorkflow(args: SyncConfigArgs) {
  return SyncConfigActivity(args);
}
