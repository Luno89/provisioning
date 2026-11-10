import { proxyActivities } from '@temporalio/workflow';
import type { DestroyAppArgs, DestroyAppResult } from '../activities/DestroyAppActivity.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { handedOver } from './handed-over.js';
import { startMachineCluster, stopMachineClusterWhenIdle } from './machine-cluster.js';

const { DestroyAppActivity } = proxyActivities<{ DestroyAppActivity: (args: DestroyAppArgs) => Promise<DestroyAppResult> }>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export async function executeDestroyAppWorkflow(args: DestroyAppArgs) {
  const destroyed = await DestroyAppActivity(await handedOver(args, startMachineCluster));
  if (args.machine) await stopMachineClusterWhenIdle(args.machine, args.clusterId);
  return destroyed;
}
