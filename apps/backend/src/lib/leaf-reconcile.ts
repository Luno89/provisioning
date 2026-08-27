/**
 * Making a leaf's recorded status match what actually happened to its workflow.
 *
 * ── THE GAP THIS FILLS ──
 * The reconciliation loop covers clusters, deployments and pipeline runs. Leaves were never added
 * to it — the same omission `run-reconcile.ts` was written for, one resource along.
 *
 * A leaf has one other backstop, `readyToStart` in lib/leaves.ts, and it cannot help here: it
 * requires `!l.workflowId`, and `LeafWorkflow` claims the id immediately. So the moment a leaf has
 * a workflow, the only thing that can ever move it again is that workflow.
 *
 * Measured: two leaves sat `pending` for FOUR AND A HALF DAYS, each holding a `workflowId` for a
 * workflow Temporal no longer had. Nothing was watching, nothing could restart them, and because
 * `requestFinished` is false while any leaf is pending or running, their branch could never land
 * its work or run its acceptance either. One wedged leaf silently freezes a whole request.
 *
 * ── WHY THIS DECIDES AN ACTION AND NOT A STATUS ──
 * A pipeline run can only be corrected to `failed`. A leaf has a second, better option: it may be
 * restartable. Clearing a dead `workflowId` hands it back to `readyToStart`, and the agent resumes
 * from its own branch — the checkpoint machinery already tells it "work so far is committed on
 * koala/<id> and will be waiting at /work/repo next attempt". Failing a leaf that could simply run
 * again would throw away that work.
 *
 * Pure, so the rules can be tested without a Temporal client.
 */
import { MAX_LEAF_ATTEMPTS, shouldRetry, type LeafStatus } from './leaves.js';

/** The statuses that are still owed an answer. Anything else has settled. */
export const LIVE_LEAF_STATUSES = ['pending', 'running'] as const;

const isLive = (status: LeafStatus): boolean =>
  (LIVE_LEAF_STATUSES as readonly string[]).includes(status);

export interface LeafReconcileAction {
  /**
   * `restart` clears the dead workflowId so the existing backstop can pick the leaf up.
   * `fail` settles it, which is what actually unblocks the branch.
   */
  action: 'restart' | 'fail';
  /** Said in a way a person can check, and recorded on the leaf's attempts. */
  reason: string;
}

/**
 * What a workflow's state means for the leaf that owns it.
 *
 * `undefined` means leave the record alone — the workflow is genuinely alive, or Temporal could not
 * be read. Those are deliberately the same answer: reconciling on a guess during a brief outage
 * would fail every running leaf at once.
 */
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
      /**
       * LeafWorkflow writes a terminal status before it returns. A COMPLETED workflow over a live
       * row means that write was lost, and the outcome is genuinely unknown — the workflow returns
       * normally whether the work succeeded or failed. `failed` is the honest answer: a leaf that
       * is not running and has no recorded result is not a leaf that succeeded, and calling it one
       * would merge unverified work.
       */
      return { action: 'fail', reason: 'Its workflow ended without recording an outcome.' };

    case 'TERMINATED':
    case 'CANCELED':
      // Somebody stopped this on purpose. Restarting it would fight them.
      return { action: 'fail', reason: `Its workflow was ${workflowStatus.toLowerCase()}.` };

    case 'FAILED':
    case 'TIMED_OUT':
      return {
        action: 'fail',
        reason: `Its workflow ${workflowStatus === 'TIMED_OUT' ? 'timed out' : 'failed'} `
          + `after ${attempts} attempt(s) of ${maxAttempts}.`,
      };

    default:
      // Unknown or unreachable. Say nothing rather than something wrong.
      return undefined;
  }
}

/**
 * A leaf whose workflow Temporal has never heard of.
 *
 * Distinct from "could not reach Temporal": NOT_FOUND is an answer. The workflow was terminated and
 * its history aged out, or it was never started. Either way nothing is coming to move this leaf.
 *
 * Restartable while attempts remain, because the work lives on the leaf's own git branch and is not
 * lost by running again. Gated on age so a leaf started a moment ago — whose workflow may not be
 * visible yet — is not stolen from the workflow that is about to claim it.
 */
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
