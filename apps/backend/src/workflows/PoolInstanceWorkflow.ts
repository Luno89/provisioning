import { proxyActivities } from '@temporalio/workflow';
import type * as pool from '../activities/PoolActivities.js';
import { LIVE_ACTIVITY } from '../lib/activity-liveness.js';

const steps = proxyActivities<typeof pool>({ ...LIVE_ACTIVITY, retry: { maximumAttempts: 3 } });
const record = proxyActivities<Pick<typeof pool, 'PoolFailedActivity'>>({ ...LIVE_ACTIVITY, retry: { maximumAttempts: 10 } });

export interface PoolInstanceInput {
  instanceId: string;
}

export async function PoolInstanceWorkflow(input: PoolInstanceInput): Promise<void> {
  try {
    await steps.PoolHostActivity();
    await steps.PoolVclusterActivity(input);
    await steps.PoolProxyActivity();
    await steps.PoolChartActivity(input);
    await steps.PoolReadyActivity(input);
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message;
    await record.PoolFailedActivity({ instanceId: input.instanceId, reason: cause });
    throw error;
  }
}
