/**
 * SyncConfigWorkflow - orchestrates re-applying a deployment's current config + restart.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { SyncConfigArgs, SyncConfigResult } from '../activities/SyncConfigActivity.js';
import { awaitWorkload } from './await-workload.js';
// From lib/activity-timeouts.ts, not the activity file directly — see AppDeployWorkflow.ts for
// why (a value import from an activity file breaks Temporal's webpack workflow bundling).
import { syncConfigActivityMeta } from '../lib/activity-timeouts.js';

// syncConfigActivityMeta.startToCloseTimeout, not a hardcoded '30 minutes' — see
// AppDeployWorkflow.ts for why (this activity declares 80 min).
const { SyncConfigActivity } = proxyActivities<{ SyncConfigActivity: (args: SyncConfigArgs) => Promise<SyncConfigResult> }>({ startToCloseTimeout: syncConfigActivityMeta.startToCloseTimeout });

/**
 * The rollout is watched here for the same reason it is watched on deploy.
 *
 * This workflow exists to change a running workload's config and force a restart, so it is the
 * operation most likely to replace working pods with broken ones — and the explicit `kubectl
 * rollout restart` it issues happens after Terraform's own wait has finished, so nothing was
 * checking the pods that restart actually produced.
 */
export async function executeSyncConfigWorkflow(args: SyncConfigArgs) {
  const result = await SyncConfigActivity(args);
  const verdict = await awaitWorkload(args.name, args.clusterId);
  return { ...result, ...verdict };
}
