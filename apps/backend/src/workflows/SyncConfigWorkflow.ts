import { patched, proxyActivities } from '@temporalio/workflow';
import type { SyncConfigArgs, SyncConfigResult } from '../activities/SyncConfigActivity.js';
import { awaitWorkload } from './await-workload.js';
import { handedOver } from './handed-over.js';
import { startMachineCluster } from './machine-cluster.js';
import { readyModel } from './ready-model.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';

const { SyncConfigActivity } = proxyActivities<{ SyncConfigActivity: (args: SyncConfigArgs) => Promise<SyncConfigResult> }>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export const MODELS_READY_ON_SYNC_PATCH = 'models-ready-on-sync';

export async function executeSyncConfigWorkflow(given: SyncConfigArgs) {
  const args = await handedOver(given, startMachineCluster);
  const modelPreDownloaded = patched(MODELS_READY_ON_SYNC_PATCH) ? await readyModel(args) : false;
  const result = await SyncConfigActivity({ ...args, modelPreDownloaded });
  const verdict = await awaitWorkload({ name: args.name, namespace: args.namespace, clusterId: args.clusterId, reach: args.reach, logFile: args.logFile });
  return { ...result, ...verdict };
}
