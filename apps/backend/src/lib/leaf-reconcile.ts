import { MAX_LEAF_ATTEMPTS, shouldRetry, type LeafStatus } from './leaves.js';

export const LIVE_LEAF_STATUSES = ['pending', 'running'] as const;

const isLive = (status: LeafStatus): boolean =>
  (LIVE_LEAF_STATUSES as readonly string[]).includes(status);

export interface LeafReconcileAction {
  action: 'restart' | 'fail';
  reason: string;
}

export function reconcileLeaf(
  current: LeafStatus,
  workflowStatus: string | undefined,
  attempts: number,
  maxAttempts = MAX_LEAF_ATTEMPTS,
): LeafReconcileAction | undefined {
  if (!isLive(current)) return undefined;

  switch (workflowStatus) {
    case 'RUNNING':
    case 'CONTINUED_AS_NEW':
      return undefined;

    case 'COMPLETED':
      return { action: 'fail', reason: 'Its workflow ended without recording an outcome.' };

    case 'TERMINATED':
    case 'CANCELED':
      return { action: 'fail', reason: `Its workflow was ${workflowStatus.toLowerCase()}.` };

    case 'FAILED':
    case 'TIMED_OUT':
      return {
        action: 'fail',
        reason: `Its workflow ${workflowStatus === 'TIMED_OUT' ? 'timed out' : 'failed'} `
          + `after ${attempts} attempt(s) of ${maxAttempts}.`,
      };

    default:
      return undefined;
  }
}

export function reconcileMissingLeafWorkflow(
  current: LeafStatus,
  updatedAt: string | undefined,
  attempts: number,
  now = Date.now(),
  graceMs = 120_000,
  maxAttempts = MAX_LEAF_ATTEMPTS,
): LeafReconcileAction | undefined {
  if (!isLive(current)) return undefined;
  const seen = updatedAt ? new Date(updatedAt).getTime() : NaN;
  if (!Number.isFinite(seen) || now - seen < graceMs) return undefined;

  if (shouldRetry(attempts, maxAttempts)) {
    return {
      action: 'restart',
      reason: 'Its workflow no longer exists, so it was handed back to the queue.',
    };
  }
  return {
    action: 'fail',
    reason: `Its workflow no longer exists and it has used all ${maxAttempts} attempts.`,
  };
}
