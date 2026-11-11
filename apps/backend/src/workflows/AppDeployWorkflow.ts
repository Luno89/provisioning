import { patched, proxyActivities } from '@temporalio/workflow';
import { handedOver } from './handed-over.js';
import type { DeployAppArgs, DeployAppResult } from '../activities/DeployAppActivity.js';
import type { VerifyGpuRuntimeArgs } from '../activities/VerifyGpuRuntimeActivity.js';
import { awaitWorkload } from './await-workload.js';
import { startMachineCluster } from './machine-cluster.js';
import { readyModel } from './ready-model.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';

const { DeployAppActivity } = proxyActivities<{ DeployAppActivity: (args: DeployAppArgs) => Promise<DeployAppResult> }>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });
const { VerifyGpuRuntimeActivity } = proxyActivities<{ VerifyGpuRuntimeActivity: (args: VerifyGpuRuntimeArgs) => Promise<void> }>({ retry: { maximumAttempts: 1 }, ...LIVE_ACTIVITY });

export const GPUS_READIED_PATCH = 'gpus-readied';

export async function executeDeployAppWorkflow(given: DeployAppArgs) {
  const args = await handedOver(given, startMachineCluster);
  if (patched(GPUS_READIED_PATCH)) {
    const gpuApp = args.appType === 'tabbyapi' || args.appType === 'vllm';
    const count = args.appType === 'tabbyapi' ? args.tabbyGpuCount : args.vllmGpuCount;
    if (gpuApp && count !== 0) {
      await VerifyGpuRuntimeActivity({ clusterId: args.clusterId, reach: args.reach, vendor: args.appType === 'tabbyapi' ? 'nvidia' : args.vllmGpuVendor, count, machine: args.clusterName, logFile: args.logFile });
    }
  } else if (args.appType === 'tabbyapi' && (args.tabbyGpuCount === undefined || args.tabbyGpuCount > 0)) {
    await VerifyGpuRuntimeActivity({ clusterId: args.clusterId, reach: args.reach, vendor: 'nvidia' });
  } else if (
    args.appType === 'vllm'
    && (args.vllmGpuCount === undefined || args.vllmGpuCount > 0)
    && (args.vllmGpuVendor || 'nvidia') === 'nvidia'
  ) {
    await VerifyGpuRuntimeActivity({ clusterId: args.clusterId, reach: args.reach, vendor: 'nvidia' });
  }

  const modelPreDownloaded = await readyModel(args);
  const result = await DeployAppActivity({ ...args, modelPreDownloaded });
  const verdict = await awaitWorkload({ name: args.name, namespace: args.namespace, clusterId: args.clusterId, reach: args.reach, logFile: args.logFile });
  return { ...result, ...verdict };
}
