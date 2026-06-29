/**
 * ResizeDiskWorkflow - orchestrates disk resizing for a specific deployment.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { ResizeDiskArgs } from '../activities/ResizeDiskActivity.js';

const { ResizeDiskActivity } = proxyActivities<{ ResizeDiskActivity: ResizeDiskArgs }>({ startToCloseTimeout: '30 minutes' });

export async function executeResizeDiskWorkflow(args: ResizeDiskArgs) {
  return ResizeDiskActivity(args);
}
