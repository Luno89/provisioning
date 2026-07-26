/**
 * PipelineRunWorkflow - orchestrates building a sibling project's pushed commit.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { RunPipelineArgs } from '../activities/RunPipelineActivity.js';
// From lib/activity-timeouts.ts, not the activity file directly — see AppDeployWorkflow.ts for
// why (a value import from an activity file breaks Temporal's webpack workflow bundling).
import { runPipelineActivityMeta } from '../lib/activity-timeouts.js';

const { RunPipelineActivity } = proxyActivities<{ RunPipelineActivity: RunPipelineArgs }>({ startToCloseTimeout: runPipelineActivityMeta.startToCloseTimeout });

export async function executePipelineRunWorkflow(args: RunPipelineArgs) {
  return RunPipelineActivity(args);
}
