import { ApplicationFailure, ParentClosePolicy, proxyActivities, startChild, workflowInfo } from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { AgentRunWorkflow } from './AgentRunWorkflow.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';
import type { AdoptedRecords } from '../engine-host/plan-adoption.js';
import type { AdoptedPlan } from '../lib/plan-proposals.js';
import { RUN_ID_MEMO, groveRunWorkflowId, type AdoptPlanArgs, type AdoptPlanResult, type ProcedureRunInput } from '../engine-host/temporal/contracts.js';
import { ownerIn, startedFor } from '../lib/workflow-owner.js';
import { LIVE_ACTIVITY } from '../lib/activity-liveness.js';

const { PlanAdoptStopActivity, PlanAdoptRecordsActivity, PlanAdoptDocumentsActivity, PlanAdoptSettleActivity, GroveRunInputActivity } = proxyActivities<{
  GroveRunInputActivity(args: { treeId: string; ownerId: string }): Promise<ProcedureRunInput>;
  PlanAdoptStopActivity(args: AdoptPlanArgs): Promise<string[]>;
  PlanAdoptRecordsActivity(args: AdoptPlanArgs): Promise<AdoptedRecords>;
  PlanAdoptDocumentsActivity(args: AdoptPlanArgs & { records: AdoptedRecords }): Promise<string>;
  PlanAdoptSettleActivity(args: AdoptPlanArgs & { status: 'adopted' | 'failed'; adopted?: AdoptedPlan | undefined; reason?: string | undefined }): Promise<void>;
}>({
  retry: { ...ACTIVITY_RETRY, maximumAttempts: 3 },
  ...LIVE_ACTIVITY,
});

const reasonOf = (err: unknown): string => {
  const cause = err instanceof ApplicationFailure || !(err instanceof Error) ? err : (err.cause ?? err);
  return cause instanceof Error ? cause.message : String(cause);
};

export async function AdoptPlanWorkflow(args: AdoptPlanArgs): Promise<AdoptPlanResult> {
  try {
    await PlanAdoptStopActivity(args);
    const records = await PlanAdoptRecordsActivity(args);
    const commit = await PlanAdoptDocumentsActivity({ ...args, records });
    const adopted: AdoptedPlan = { ...records.adopted, commit };
    await PlanAdoptSettleActivity({ ...args, status: 'adopted', adopted });
    const growing = records.grow === false ? { started: false as const, reason: 'nothing was put back in line to work' } : await growTree(adopted.treeId, args.ownerId);
    return { proposalId: args.proposalId, status: 'adopted', treeId: adopted.treeId, commit, growing };
  } catch (err) {
    const reason = reasonOf(err);
    await PlanAdoptSettleActivity({ ...args, status: 'failed', reason });
    return { proposalId: args.proposalId, status: 'failed', reason };
  }
}

async function growTree(treeId: string, ownerId: string): Promise<{ started: true } | { started: false; reason: string }> {
  try {
    await runTree(treeId, ownerId);
    return { started: true };
  } catch (err) {
    return { started: false, reason: reasonOf(err) };
  }
}

async function runTree(treeId: string, ownerId: string): Promise<void> {
  try {
    const input = await GroveRunInputActivity({ treeId, ownerId });
    await startChild(AgentRunWorkflow, {
      workflowId: groveRunWorkflowId(treeId),
      args: [input],
      memo: { [RUN_ID_MEMO]: input.ticket.runId },
      ...startedFor(ownerIn(workflowInfo().typedSearchAttributes) ?? ownerId),
      parentClosePolicy: ParentClosePolicy.ABANDON,
    });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }
}

