/**
 * DestroyAppWorkflow
 *
 * Orchestrates the lifecycle of an application destruction (CDKTF destroy
 * + Kubernetes namespace deletion).
 */
import { proxyActivities } from '@temporalio/workflow';
import type { DestroyAppArgs, DestroyAppResult } from '../activities/DestroyAppActivity.js';
// From lib/activity-timeouts.ts, not the activity file directly — see AppDeployWorkflow.ts for
// why (a value import from an activity file breaks Temporal's webpack workflow bundling).
import { destroyAppActivityMeta } from '../lib/activity-timeouts.js';

// destroyAppActivityMeta.startToCloseTimeout, not a hardcoded '30 minutes' — see
// AppDeployWorkflow.ts for why (this activity declares 60 min).
const { DestroyAppActivity } = proxyActivities<{ DestroyAppActivity: (args: DestroyAppArgs) => Promise<DestroyAppResult> }>({ startToCloseTimeout: destroyAppActivityMeta.startToCloseTimeout });

export async function executeDestroyAppWorkflow(args: DestroyAppArgs) {
  return DestroyAppActivity(args);
}
