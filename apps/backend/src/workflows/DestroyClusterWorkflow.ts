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
//
// maximumAttempts is set because Temporal's default is UNLIMITED, and a destroy failure is very
// often deterministic rather than transient: a cluster named "VPS -test" could never be destroyed
// at all, because CDKTF refuses to synthesize a stack id containing whitespace exactly as it
// refused to provision one. That retried every few seconds forever, pinning the record in
// 'destroying' with no way out of the UI. Five attempts still absorbs a genuinely transient
// provider blip, but a permanent failure now surfaces as a failed workflow the reconciliation
// loop can act on.
const { DestroyClusterActivity } = proxyActivities<{ DestroyClusterActivity: (args: DestroyClusterArgs) => Promise<DestroyClusterResult> }>({
  startToCloseTimeout: destroyClusterActivityMeta.startToCloseTimeout,
  retry: { maximumAttempts: 5 },
});

export async function executeDestroyClusterWorkflow(args: DestroyClusterArgs) {
  const result = await DestroyClusterActivity(args);
  return result;
}
