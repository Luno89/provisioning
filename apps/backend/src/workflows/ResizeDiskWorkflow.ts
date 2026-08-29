import { proxyActivities } from '@temporalio/workflow';
import type { ResizeDiskArgs, ResizeDiskResult } from '../activities/ResizeDiskActivity.js';
import { awaitWorkload } from './await-workload.js';
import { resizeDiskActivityMeta } from '../lib/activity-timeouts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { ResizeDiskActivity } = proxyActivities<{ ResizeDiskActivity: (args: ResizeDiskArgs) => Promise<ResizeDiskResult> }>({ retry: ACTIVITY_RETRY, startToCloseTimeout: resizeDiskActivityMeta.startToCloseTimeout });

export async function executeResizeDiskWorkflow(args: ResizeDiskArgs) {
  const result = await ResizeDiskActivity(args);
  const verdict = await awaitWorkload(args.name, args.clusterId);
  return { ...result, ...verdict };
}
