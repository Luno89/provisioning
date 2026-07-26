/**
 * ResizeDiskWorkflow - orchestrates disk resizing for a specific deployment.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { ResizeDiskArgs } from '../activities/ResizeDiskActivity.js';
// From lib/activity-timeouts.ts, not the activity file directly — see AppDeployWorkflow.ts for
// why (a value import from an activity file breaks Temporal's webpack workflow bundling).
import { resizeDiskActivityMeta } from '../lib/activity-timeouts.js';

// resizeDiskActivityMeta.startToCloseTimeout, not a hardcoded '30 minutes' — see
// AppDeployWorkflow.ts for why (this activity declares 80 min).
const { ResizeDiskActivity } = proxyActivities<{ ResizeDiskActivity: ResizeDiskArgs }>({ startToCloseTimeout: resizeDiskActivityMeta.startToCloseTimeout });

export async function executeResizeDiskWorkflow(args: ResizeDiskArgs) {
  return ResizeDiskActivity(args);
}
