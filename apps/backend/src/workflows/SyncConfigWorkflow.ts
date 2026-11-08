import { proxyActivities } from '@temporalio/workflow';
import type { SyncConfigArgs, SyncConfigResult } from '../activities/SyncConfigActivity.js';
import { awaitWorkload } from './await-workload.js';
import { handedOver } from './handed-over.js';
import { startMachineCluster } from './machine-cluster.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';

const { SyncConfigActivity } = proxyActivities<{ SyncConfigActivity: (args: SyncConfigArgs) => Promise<SyncConfigResult> }>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export async function executeSyncConfigWorkflow(given: SyncConfigArgs) {
  const args = await handedOver(given, startMachineCluster);
  const result = await SyncConfigActivity(args);
  const verdict = await awaitWorkload({ name: args.name, namespace: args.namespace, clusterId: args.clusterId, reach: args.reach });
  return { ...result, ...verdict };
}
