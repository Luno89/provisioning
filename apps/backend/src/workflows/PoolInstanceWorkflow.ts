import { condition, defineSignal, ParentClosePolicy, proxyActivities, setHandler, startChild, WorkflowIdReusePolicy } from '@temporalio/workflow';
import type { ProvisionReport } from '@koala/engine-core/koala-install';
import { PoolTrialWorkflow } from './PoolTrialWorkflow.js';
import { POOL_SETUP_HEARD, poolTrialWorkflowId } from '../instances/lib/pool-trial.js';
import type * as pool from '../activities/PoolActivities.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';

const steps = proxyActivities<typeof pool>({ ...LIVE_ACTIVITY, retry: ACTIVITY_RETRY });
const record = proxyActivities<Pick<typeof pool, 'PoolFailedActivity'>>({ ...LIVE_ACTIVITY, retry: ACTIVITY_RETRY });
const setup = proxyActivities<Pick<typeof pool, 'PoolSetupActivity'>>({ ...LIVE_ACTIVITY, retry: ACTIVITY_RETRY });

export const poolSetupHeard = defineSignal<[ProvisionReport]>(POOL_SETUP_HEARD);

export interface PoolInstanceInput {
  instanceId: string;
}

export async function PoolInstanceWorkflow(input: PoolInstanceInput): Promise<void> {
  const heard: ProvisionReport[] = [];
  setHandler(poolSetupHeard, (report) => { heard.push(report); });
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
  for (;;) {
    await condition(() => heard.length > 0);
    if (await setup.PoolSetupActivity({ instanceId: input.instanceId, report: heard.shift()! })) break;
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
