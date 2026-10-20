import { getExternalWorkflowHandle, proxyActivities } from '@temporalio/workflow';
import type * as pool from '../activities/PoolActivities.js';
import { LIVE_ACTIVITY } from '../lib/activity-liveness.js';
import { poolTrialWorkflowId, TRIAL_CHANGED } from '../lib/pool-trial.js';

const { PoolRemoveActivity } = proxyActivities<Pick<typeof pool, 'PoolRemoveActivity'>>({ ...LIVE_ACTIVITY, retry: { maximumAttempts: 10 } });

export async function PoolRemoveWorkflow(input: { instanceId: string }): Promise<void> {
  await PoolRemoveActivity(input);
  await getExternalWorkflowHandle(poolTrialWorkflowId(input.instanceId)).signal(TRIAL_CHANGED).catch(() => undefined);
}
