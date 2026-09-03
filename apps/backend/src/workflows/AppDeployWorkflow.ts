import { proxyActivities } from '@temporalio/workflow';
import type { DeployAppArgs, DeployAppResult } from '../activities/DeployAppActivity.js';
import type { DownloadModelArgs } from '../activities/DownloadModelActivity.js';
import type { VerifyGpuRuntimeArgs } from '../activities/VerifyGpuRuntimeActivity.js';
import { awaitWorkload } from './await-workload.js';
import { deployAppActivityMeta, downloadModelActivityMeta, verifyGpuRuntimeActivityMeta } from '../lib/activity-timeouts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { DeployAppActivity } = proxyActivities<{ DeployAppActivity: (args: DeployAppArgs) => Promise<DeployAppResult> }>({ retry: ACTIVITY_RETRY, startToCloseTimeout: deployAppActivityMeta.startToCloseTimeout });
const { DownloadModelActivity } = proxyActivities<{ DownloadModelActivity: (args: DownloadModelArgs) => Promise<unknown> }>({ retry: ACTIVITY_RETRY, startToCloseTimeout: downloadModelActivityMeta.startToCloseTimeout });
const { VerifyGpuRuntimeActivity } = proxyActivities<{ VerifyGpuRuntimeActivity: (args: VerifyGpuRuntimeArgs) => Promise<void> }>({ retry: { maximumAttempts: 1 }, startToCloseTimeout: verifyGpuRuntimeActivityMeta.startToCloseTimeout });

export async function executeDeployAppWorkflow(args: DeployAppArgs) {
  if (args.appType === 'tabbyapi' && (args.tabbyGpuCount === undefined || args.tabbyGpuCount > 0)) {
    await VerifyGpuRuntimeActivity({ clusterId: args.clusterId, vendor: 'nvidia' });
  } else if (
    args.appType === 'vllm'
    && (args.vllmGpuCount === undefined || args.vllmGpuCount > 0)
    && (args.vllmGpuVendor || 'nvidia') === 'nvidia'
  ) {
    await VerifyGpuRuntimeActivity({ clusterId: args.clusterId, vendor: 'nvidia' });
  }

  if (args.appType === 'tabbyapi' && args.modelCacheHostPath && args.tabbyModel) {
    await DownloadModelActivity({
      modelRepo: args.tabbyModel,
      revision: args.tabbyRevision,
      hfToken: args.tabbyHfToken,
      cacheHostPath: args.modelCacheHostPath,
      logFile: args.logFile,
    });
  } else if (args.appType === 'vllm' && args.modelCacheHostPath && args.vllmModel) {
    await DownloadModelActivity({
      modelRepo: args.vllmModel,
      hfToken: args.vllmHfToken,
      cacheHostPath: args.modelCacheHostPath,
      logFile: args.logFile,
    });
  }
  const result = await DeployAppActivity(args);
  const verdict = await awaitWorkload(args.name, args.clusterId);
  return { ...result, ...verdict };
}
