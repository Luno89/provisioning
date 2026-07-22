/**
 * SyncConfigWorkflow - orchestrates re-applying a deployment's current config + restart.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { SyncConfigArgs } from '../activities/SyncConfigActivity.js';

const { SyncConfigActivity } = proxyActivities<{ SyncConfigActivity: SyncConfigArgs }>({ startToCloseTimeout: '30 minutes' });

export async function executeSyncConfigWorkflow(args: SyncConfigArgs) {
  return SyncConfigActivity(args);
}
