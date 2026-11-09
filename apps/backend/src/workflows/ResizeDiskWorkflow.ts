import { proxyActivities } from '@temporalio/workflow';
import type { ResizeDiskArgs, ResizeDiskResult } from '../activities/ResizeDiskActivity.js';
import { awaitWorkload } from './await-workload.js';
import { handedOver } from './handed-over.js';
import { startMachineCluster } from './machine-cluster.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';

const { ResizeDiskActivity } = proxyActivities<{ ResizeDiskActivity: (args: ResizeDiskArgs) => Promise<ResizeDiskResult> }>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export async function executeResizeDiskWorkflow(given: ResizeDiskArgs) {
  const args = await handedOver(given, startMachineCluster);
  const result = await ResizeDiskActivity(args);
  const verdict = await awaitWorkload({ name: args.name, namespace: args.namespace, clusterId: args.clusterId, reach: args.reach, logFile: args.logFile });
  return { ...result, ...verdict };
}
