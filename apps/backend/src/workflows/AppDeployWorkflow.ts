import { proxyActivities } from '@temporalio/workflow';
import type { DeployAppArgs, DeployAppResult } from '../activities/DeployAppActivity.js';
import type { DownloadModelArgs } from '../activities/DownloadModelActivity.js';
import { awaitWorkload } from './await-workload.js';
import { deployAppActivityMeta, downloadModelActivityMeta } from '../lib/activity-timeouts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { DeployAppActivity } = proxyActivities<{ DeployAppActivity: (args: DeployAppArgs) => Promise<DeployAppResult> }>({ retry: ACTIVITY_RETRY, startToCloseTimeout: deployAppActivityMeta.startToCloseTimeout });
const { DownloadModelActivity } = proxyActivities<{ DownloadModelActivity: (args: DownloadModelArgs) => Promise<unknown> }>({ retry: ACTIVITY_RETRY, startToCloseTimeout: downloadModelActivityMeta.startToCloseTimeout });

export async function executeDeployAppWorkflow(args: DeployAppArgs) {
  if (args.appType === 'tabbyapi' && args.modelCacheHostPath && args.tabbyModel) {
    await DownloadModelActivity({
      modelRepo: args.tabbyModel,
      revision: args.tabbyRevision,
      hfToken: args.tabbyHfToken,
      cacheHostPath: args.modelCacheHostPath,
    });
  }
  const result = await DeployAppActivity(args);
  const verdict = await awaitWorkload(args.name, args.clusterId);
  return { ...result, ...verdict };
}
