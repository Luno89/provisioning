import { proxyActivities } from '@temporalio/workflow';
import type { SyncConfigArgs, SyncConfigResult } from '../activities/SyncConfigActivity.js';
import { awaitWorkload } from './await-workload.js';
import { syncConfigActivityMeta } from '../lib/activity-timeouts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { SyncConfigActivity } = proxyActivities<{ SyncConfigActivity: (args: SyncConfigArgs) => Promise<SyncConfigResult> }>({ retry: ACTIVITY_RETRY, startToCloseTimeout: syncConfigActivityMeta.startToCloseTimeout });

export async function executeSyncConfigWorkflow(args: SyncConfigArgs) {
  const result = await SyncConfigActivity(args);
  const verdict = await awaitWorkload(args.name, args.clusterId);
  return { ...result, ...verdict };
}
