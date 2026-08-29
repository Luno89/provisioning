import { proxyActivities } from '@temporalio/workflow';
import type { RunPipelineArgs, RunPipelineResult } from '../activities/RunPipelineActivity.js';
import { runPipelineActivityMeta } from '../lib/activity-timeouts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { RunPipelineActivity } = proxyActivities<{ RunPipelineActivity: (args: RunPipelineArgs) => Promise<RunPipelineResult> }>({ retry: ACTIVITY_RETRY, startToCloseTimeout: runPipelineActivityMeta.startToCloseTimeout });

export async function executePipelineRunWorkflow(args: RunPipelineArgs) {
  return RunPipelineActivity(args);
}
