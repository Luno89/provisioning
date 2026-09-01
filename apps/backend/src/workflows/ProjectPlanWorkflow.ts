import { proxyActivities } from '@temporalio/workflow';
import type { PlanProjectArgs, PlanProjectResult } from '../activities/PlanProjectActivity.js';
import { planProjectActivityMeta } from '../lib/activity-timeouts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { PlanProjectActivity } = proxyActivities<{
  PlanProjectActivity: (args: PlanProjectArgs) => Promise<PlanProjectResult>;
}>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: planProjectActivityMeta.startToCloseTimeout,
});

/**
 * Planning a newly accepted project. Durable because a planning turn takes several rounds and a
 * research call each, and the accept request must not hold the connection open for it.
 */
export async function ProjectPlanWorkflow(args: PlanProjectArgs): Promise<PlanProjectResult> {
  return PlanProjectActivity(args);
}
