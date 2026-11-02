import {
  ContinueAsNew, isCancellation, patched, proxyActivities, workflowInfo,
  type Next, type WorkflowExecuteInput, type WorkflowInboundCallsInterceptor, type WorkflowInterceptors,
} from '@temporalio/workflow';
import { TemporalFailure } from '@temporalio/common';
import { DEFAULT_STREAM_TASK_QUEUE, FAILURES_REPORTED_PATCH, type WorkflowFailedReport } from '../engine-host/temporal/contracts.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { ignore } from '@koala/engine-core/failures';
import { ownerIn } from '../platform/lib/workflow-owner.js';

const told = proxyActivities<{ EngineWorkflowFailedActivity(report: WorkflowFailedReport): Promise<void> }>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: ACTIVITY_RETRY,
  ...LIVE_ACTIVITY,
});

export const failedWorkflow = (err: unknown): err is TemporalFailure =>
  err instanceof TemporalFailure && !isCancellation(err) && !(err instanceof ContinueAsNew);

class ReportFailure implements WorkflowInboundCallsInterceptor {
  async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    try {
      return await next(input);
    } catch (err) {
      if (failedWorkflow(err) && patched(FAILURES_REPORTED_PATCH)) {
        const info = workflowInfo();
        const owner = ownerIn(info.typedSearchAttributes);
        await told.EngineWorkflowFailedActivity({
          workflowId: info.workflowId,
          temporalRunId: info.runId,
          type: info.workflowType,
          ...(owner ? { ownerId: owner } : {}),
          ...(info.parent ? { parent: info.parent.workflowId } : {}),
          startedAt: info.runStartTime.toISOString(),
          failedAt: new Date().toISOString(),
          ...(info.memo ? { memo: info.memo } : {}),
          message: err.message,
          ...(err.cause?.message ? { cause: err.cause.message } : {}),
        }).catch(ignore('the workflow still ends with its own failure when the backend could not take the report'));
      }
      throw err;
    }
  }
}

export const interceptors = (): WorkflowInterceptors => ({ inbound: [new ReportFailure()] });
