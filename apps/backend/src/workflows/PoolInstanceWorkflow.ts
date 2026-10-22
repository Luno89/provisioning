import { ParentClosePolicy, proxyActivities, startChild, WorkflowIdReusePolicy } from '@temporalio/workflow';
import { PoolTrialWorkflow } from './PoolTrialWorkflow.js';
import { poolTrialWorkflowId } from '../instances/lib/pool-trial.js';
import type * as pool from '../activities/PoolActivities.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';

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
  await startChild(PoolTrialWorkflow, {
    workflowId: poolTrialWorkflowId(input.instanceId),
    args: [input],
    parentClosePolicy: ParentClosePolicy.ABANDON,
    workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
  }).catch((error: Error) => {
    if (!/already started|AlreadyStarted/i.test(error.message) && error.name !== 'WorkflowExecutionAlreadyStartedError') throw error;
  });
}
