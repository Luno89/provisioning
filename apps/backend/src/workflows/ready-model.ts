import { proxyActivities } from '@temporalio/workflow';
import type { DownloadModelArgs, DownloadModelResult } from '../activities/DownloadModelActivity.js';
import type { Reach } from '../infrastructure/index.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';

const { DownloadModelActivity } = proxyActivities<{ DownloadModelActivity: (args: DownloadModelArgs) => Promise<DownloadModelResult> }>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export interface ModelToReady {
  appType: string;
  clusterId: string;
  reach?: Reach | undefined;
  logFile?: string | undefined;
  modelCacheHostPath?: string | undefined;
  modelImage?: string | undefined;
  vllmModel?: string | undefined;
  vllmHfToken?: string | undefined;
  tabbyModel?: string | undefined;
  tabbyRevision?: string | undefined;
  tabbyHfToken?: string | undefined;
}

export async function readyModel(args: ModelToReady): Promise<boolean> {
  const model = args.appType === 'tabbyapi' ? { repo: args.tabbyModel, revision: args.tabbyRevision, token: args.tabbyHfToken }
    : args.appType === 'vllm' ? { repo: args.vllmModel, revision: undefined, token: args.vllmHfToken } : undefined;
  if (!model?.repo || !args.modelCacheHostPath || !args.modelImage) return false;
  await DownloadModelActivity({
    clusterId: args.clusterId,
    reach: args.reach,
    image: args.modelImage,
    modelRepo: model.repo,
    revision: model.revision,
    hfToken: model.token,
    cacheHostPath: args.modelCacheHostPath,
    logFile: args.logFile,
  });
  return true;
}
