/**
 * PipelineRunWorkflow - orchestrates building a sibling project's pushed commit.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { RunPipelineArgs, RunPipelineResult } from '../activities/RunPipelineActivity.js';
// From lib/activity-timeouts.ts, not the activity file directly — see AppDeployWorkflow.ts for
// why (a value import from an activity file breaks Temporal's webpack workflow bundling).
import { runPipelineActivityMeta } from '../lib/activity-timeouts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { RunPipelineActivity } = proxyActivities<{ RunPipelineActivity: (args: RunPipelineArgs) => Promise<RunPipelineResult> }>({ retry: ACTIVITY_RETRY, startToCloseTimeout: runPipelineActivityMeta.startToCloseTimeout });

export async function executePipelineRunWorkflow(args: RunPipelineArgs) {
  return RunPipelineActivity(args);
}
