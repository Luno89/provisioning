import { runningItems, type OpensAt, type RunningKind, type RunningRecords, type RunningWorkflow } from './running.js';

export interface WorkFailure {
  id: string;
  ownerId: string;
  workflowId: string;
  kind: RunningKind;
  title: string;
  opens: OpensAt;
  reason: string;
  failedAt: string;
  clearedAt?: string | undefined;
}

export const SHOWN_FOR_MS = 7 * 86_400_000;
export const KEPT_FOR_MS = 30 * 86_400_000;

export const FAILURE_SHOWN_ON_RECORD: readonly string[] = ['executeAppDeployWorkflow', 'ClusterProvisionWorkflow'];

export const runFailureId = (runId: string): string => `run:${runId}`;
export const workflowFailureId = (workflowId: string, temporalRunId: string): string => `workflow:${workflowId}:${temporalRunId}`;

export function describeFailure(
  workflow: RunningWorkflow,
  records: RunningRecords,
  failure: { id: string; ownerId: string; reason: string; failedAt: string },
): WorkFailure {
  const described = runningItems([{ ...workflow, parent: undefined }], records)[0];
  return {
    id: failure.id,
    ownerId: failure.ownerId,
    workflowId: workflow.workflowId,
    kind: described?.kind ?? 'other',
    title: described?.title ?? workflow.type,
    opens: described?.opens ?? { kind: 'temporal', id: workflow.workflowId },
    reason: failure.reason,
    failedAt: failure.failedAt,
  };
}

export const shownFailures = (failures: readonly WorkFailure[], now: number): WorkFailure[] =>
  failures
    .filter((failure) => !failure.clearedAt && now - Date.parse(failure.failedAt) < SHOWN_FOR_MS)
    .sort((a, b) => b.failedAt.localeCompare(a.failedAt));

export const temporalFailureReason = (failure: { message?: string | undefined; cause?: { message?: string | undefined } | undefined } | undefined, status: string): string => {
  const message = failure?.cause?.message || failure?.message;
  if (message) return message;
  return status === 'TIMED_OUT' ? 'it ran out of time' : 'it failed';
};
