/**
 * DestroyClusterWorkflow
 *
 * Orchestrates the lifecycle of a cluster destruction: triggers
 * DestroyClusterActivity and waits for completion.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { DestroyClusterArgs, DestroyClusterResult } from '../activities/DestroyClusterActivity.js';
// From lib/activity-timeouts.ts, not the activity file directly — see AppDeployWorkflow.ts for
// why (a value import from an activity file breaks Temporal's webpack workflow bundling).
import { destroyClusterActivityMeta } from '../lib/activity-timeouts.js';

// destroyClusterActivityMeta.startToCloseTimeout, not a hardcoded '30 minutes' — see
// AppDeployWorkflow.ts for why (this activity declares 60 min).
const { DestroyClusterActivity } = proxyActivities<{ DestroyClusterActivity: (args: DestroyClusterArgs) => Promise<DestroyClusterResult> }>({ startToCloseTimeout: destroyClusterActivityMeta.startToCloseTimeout });

export async function executeDestroyClusterWorkflow(args: DestroyClusterArgs) {
  const result = await DestroyClusterActivity(args);
  return result;
}
