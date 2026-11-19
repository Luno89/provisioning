import { getExternalWorkflowHandle, proxyActivities } from '@temporalio/workflow';
import type * as pool from '../activities/PoolActivities.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { poolTrialWorkflowId, TRIAL_CHANGED } from '../instances/lib/pool-trial.js';
import { ignore } from '@koala/engine-core/failures';

const { PoolRemoveActivity } = proxyActivities<Pick<typeof pool, 'PoolRemoveActivity'>>({ ...LIVE_ACTIVITY, retry: ACTIVITY_RETRY });

export async function PoolRemoveWorkflow(input: { instanceId: string }): Promise<void> {
  await PoolRemoveActivity(input);
  await getExternalWorkflowHandle(poolTrialWorkflowId(input.instanceId)).signal(TRIAL_CHANGED).catch(ignore('a trial workflow that has already ended has no schedule left to change'));
}
