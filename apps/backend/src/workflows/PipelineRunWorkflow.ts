import { proxyActivities } from '@temporalio/workflow';
import type { RunPipelineArgs, RunPipelineResult } from '../activities/RunPipelineActivity.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';

const { RunPipelineActivity } = proxyActivities<{ RunPipelineActivity: (args: RunPipelineArgs) => Promise<RunPipelineResult> }>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export async function executePipelineRunWorkflow(args: RunPipelineArgs) {
  return RunPipelineActivity(args);
}
