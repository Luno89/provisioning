import { continueAsNew, log, proxyActivities, sleep } from '@temporalio/workflow';
import { DEFAULT_STREAM_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { doStoredFilesWork, type StoredFilesActivities, type StoredFilesDone, type StoredFilesWork } from '../files/lib/stored-files-work.js';

const activities = proxyActivities<StoredFilesActivities>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: ACTIVITY_RETRY,
  ...LIVE_ACTIVITY,
});

export async function StoredFilesWorkflow(work: StoredFilesWork): Promise<StoredFilesDone> {
  return doStoredFilesWork(work, activities);
}

export async function StoredFilesSweepWorkflow(): Promise<void> {
  const swept = await activities.StoredFilesSweepActivity();
  log.info('stored files swept', { ...swept });
  await sleep('1 day');
  await continueAsNew<typeof StoredFilesSweepWorkflow>();
}
