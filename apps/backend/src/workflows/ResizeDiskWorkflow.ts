/**
 * ResizeDiskWorkflow - orchestrates disk resizing for a specific deployment.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { ResizeDiskArgs, ResizeDiskResult } from '../activities/ResizeDiskActivity.js';
import { awaitWorkload } from './await-workload.js';
// From lib/activity-timeouts.ts, not the activity file directly — see AppDeployWorkflow.ts for
// why (a value import from an activity file breaks Temporal's webpack workflow bundling).
import { resizeDiskActivityMeta } from '../lib/activity-timeouts.js';

// resizeDiskActivityMeta.startToCloseTimeout, not a hardcoded '30 minutes' — see
// AppDeployWorkflow.ts for why (this activity declares 80 min).
const { ResizeDiskActivity } = proxyActivities<{ ResizeDiskActivity: (args: ResizeDiskArgs) => Promise<ResizeDiskResult> }>({ startToCloseTimeout: resizeDiskActivityMeta.startToCloseTimeout });

/**
 * A resize rewrites the PVC and brings the pod back, so the same rollout check applies: a volume
 * that fails to re-attach leaves a Pending pod that nothing would otherwise notice.
 */
export async function executeResizeDiskWorkflow(args: ResizeDiskArgs) {
  const result = await ResizeDiskActivity(args);
  const verdict = await awaitWorkload(args.name, args.clusterId);
  return { ...result, ...verdict };
}
