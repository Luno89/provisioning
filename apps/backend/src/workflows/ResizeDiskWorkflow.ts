import { proxyActivities } from '@temporalio/workflow';
import type { ResizeDiskArgs, ResizeDiskResult } from '../activities/ResizeDiskActivity.js';
import { awaitWorkload } from './await-workload.js';
import { LIVE_ACTIVITY } from '../lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { ResizeDiskActivity } = proxyActivities<{ ResizeDiskActivity: (args: ResizeDiskArgs) => Promise<ResizeDiskResult> }>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export async function executeResizeDiskWorkflow(args: ResizeDiskArgs) {
  const result = await ResizeDiskActivity(args);
  const verdict = await awaitWorkload(args.name, args.clusterId);
  return { ...result, ...verdict };
}
