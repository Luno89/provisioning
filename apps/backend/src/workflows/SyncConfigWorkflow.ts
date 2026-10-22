import { proxyActivities } from '@temporalio/workflow';
import type { SyncConfigArgs, SyncConfigResult } from '../activities/SyncConfigActivity.js';
import { awaitWorkload } from './await-workload.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';

const { SyncConfigActivity } = proxyActivities<{ SyncConfigActivity: (args: SyncConfigArgs) => Promise<SyncConfigResult> }>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export async function executeSyncConfigWorkflow(args: SyncConfigArgs) {
  const result = await SyncConfigActivity(args);
  const verdict = await awaitWorkload(args.name, args.clusterId);
  return { ...result, ...verdict };
}
