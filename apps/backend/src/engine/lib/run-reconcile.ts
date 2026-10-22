
export const LIVE_RUN_STATUSES = ['queued', 'running'] as const;

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export function statusFromWorkflow(workflowStatus: string | undefined): RunStatus | undefined {
  switch (workflowStatus) {
    case 'COMPLETED':
      return 'succeeded';
    case 'FAILED':
    case 'TERMINATED':
    case 'TIMED_OUT':
    case 'CANCELED':
      return 'failed';
    case 'RUNNING':
    case 'CONTINUED_AS_NEW':
      return 'running';
    default:
      return undefined;
  }
}

export function reconcileRun(
  current: RunStatus,
  workflowStatus: string | undefined,
): RunStatus | undefined {
  if (!(LIVE_RUN_STATUSES as readonly string[]).includes(current)) return undefined;
  const next = statusFromWorkflow(workflowStatus);
  if (!next || next === current) return undefined;
  return next;
}

export function reconcileMissingWorkflow(
  current: RunStatus,
  startedAt: string | undefined,
  now = Date.now(),
  graceMs = 60_000,
): RunStatus | undefined {
  if (!(LIVE_RUN_STATUSES as readonly string[]).includes(current)) return undefined;
  const started = startedAt ? new Date(startedAt).getTime() : NaN;
  if (!Number.isFinite(started) || now - started < graceMs) return undefined;
  return 'failed';
}
