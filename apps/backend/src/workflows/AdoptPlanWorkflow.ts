import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';
import type { AdoptedRecords } from '../engine-host/plan-adoption.js';
import type { AdoptedPlan } from '../lib/plan-proposals.js';
import type { AdoptPlanArgs, AdoptPlanResult } from '../engine-host/temporal/contracts.js';

const { PlanAdoptRecordsActivity, PlanAdoptDocumentsActivity, PlanAdoptSettleActivity } = proxyActivities<{
  PlanAdoptRecordsActivity(args: AdoptPlanArgs): Promise<AdoptedRecords>;
  PlanAdoptDocumentsActivity(args: AdoptPlanArgs & { records: AdoptedRecords }): Promise<string>;
  PlanAdoptSettleActivity(args: AdoptPlanArgs & { status: 'adopted' | 'failed'; adopted?: AdoptedPlan | undefined; reason?: string | undefined }): Promise<void>;
}>({
  retry: { ...ACTIVITY_RETRY, maximumAttempts: 3 },
  startToCloseTimeout: '15 minutes',
});

const reasonOf = (err: unknown): string => {
  const cause = err instanceof ApplicationFailure || !(err instanceof Error) ? err : (err.cause ?? err);
  return cause instanceof Error ? cause.message : String(cause);
};

export async function AdoptPlanWorkflow(args: AdoptPlanArgs): Promise<AdoptPlanResult> {
  try {
    const records = await PlanAdoptRecordsActivity(args);
    const commit = await PlanAdoptDocumentsActivity({ ...args, records });
    const adopted: AdoptedPlan = { ...records.adopted, commit };
    await PlanAdoptSettleActivity({ ...args, status: 'adopted', adopted });
    return { proposalId: args.proposalId, status: 'adopted', treeId: adopted.treeId, commit };
  } catch (err) {
    const reason = reasonOf(err);
    await PlanAdoptSettleActivity({ ...args, status: 'failed', reason });
    return { proposalId: args.proposalId, status: 'failed', reason };
  }
}
