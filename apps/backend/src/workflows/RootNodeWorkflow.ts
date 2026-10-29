import { CancellationScope, isCancellation, log, proxyActivities, sleep } from '@temporalio/workflow';
import type * as root from '../activities/RootNodeActivities.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
export { rootNodeWorkflowId } from '../infrastructure/lib/server-orders.js';

const steps = proxyActivities<typeof root>({ ...LIVE_ACTIVITY, retry: { maximumAttempts: 5 } });

export async function RootNodeWorkflow(orderId: string): Promise<void> {
  try {
    while (!(await steps.ServerOrderFollowActivity(orderId)).delivered) await sleep('1 minute');
    await steps.ServerOrderRebuildActivity(orderId);
    while (!(await steps.ServerOrderSshActivity(orderId))) await sleep('20 seconds');
    while (!(await steps.ServerOrderDnsActivity(orderId))) await sleep('5 minutes');
    let release = await steps.ServerOrderReleaseActivity(orderId);
    while (!release) {
      await sleep('1 hour');
      release = await steps.ServerOrderReleaseActivity(orderId);
    }
    await steps.ServerOrderBootstrapActivity(orderId, release);
  } catch (error) {
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(() => steps.ServerOrderStoppedActivity(orderId));
      return;
    }
    const reason = (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message;
    log.warn('root node order stopped on a problem', { orderId, reason });
    await steps.ServerOrderFailedActivity(orderId, reason);
  }
}
