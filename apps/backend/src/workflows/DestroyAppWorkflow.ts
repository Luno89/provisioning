import { proxyActivities } from '@temporalio/workflow';
import type { DestroyAppArgs, DestroyAppResult } from '../activities/DestroyAppActivity.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { DESTROY_RETRY } from '../platform/lib/activity-retry.js';
import { startMachineCluster, stopMachineClusterWhenIdle } from './machine-cluster.js';

const { DestroyAppActivity } = proxyActivities<{ DestroyAppActivity: (args: DestroyAppArgs) => Promise<DestroyAppResult> }>({ retry: DESTROY_RETRY, ...LIVE_ACTIVITY });

export async function executeDestroyAppWorkflow(args: DestroyAppArgs) {
  const handed = args.machine ? { ...args, kubeconfig: await startMachineCluster(args.machine, args.clusterId) } : args;
  const destroyed = await DestroyAppActivity(handed);
  if (args.machine) await stopMachineClusterWhenIdle(args.machine, args.clusterId);
  return destroyed;
}
