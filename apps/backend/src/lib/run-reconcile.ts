/**
 * Making a pipeline run's recorded status match what actually happened to it.
 *
 * ── THE GAP THIS FILLS ──
 * A run's status is written by whichever poller was watching when it finished. If nothing was
 * watching — the backend restarted, the workflow was terminated by hand, Temporal was briefly
 * unreachable — the record keeps whatever it last said, forever.
 *
 * Measured: five runs sat at `queued` for over three hours after their workflows had been
 * terminated. The queue read as permanently busy, and nothing in the system disagreed, because the
 * only thing that would have written `failed` was the tracker that had already stopped.
 *
 * The reconciliation loop already does exactly this for clusters and for deployments. Pipeline runs
 * were simply never added to it — the same omission as the retry bounds, in a different file.
 *
 * ── WHY TEMPORAL IS THE AUTHORITY, NOT KUBERNETES ──
 * A build's truth is its workflow's outcome. Kubernetes knows whether a Job's pod exited, which is
 * a fact about one attempt rather than about the run — a run that is mid-retry has a dead pod and
 * is not failed. Asking the workflow gets the whole answer, including "it was terminated", which no
 * pod can report.
 */

/** The terminal statuses a run can be left in. Anything else means it is still owed an answer. */
export const LIVE_RUN_STATUSES = ['queued', 'running'] as const;

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/**
 * What a workflow's state means for the run it belongs to.
 *
 * `undefined` means leave the record alone — either the workflow is genuinely still going, or we
 * could not find out. Those are deliberately the same answer: a reconciliation that guesses when
 * Temporal is unreachable would mark every run failed during a brief outage.
 */
export function statusFromWorkflow(workflowStatus: string | undefined): RunStatus | undefined {
  switch (workflowStatus) {
    case 'COMPLETED':
      return 'succeeded';
    case 'FAILED':
    case 'TERMINATED':
    case 'TIMED_OUT':
    case 'CANCELED':
      /**
       * All failures from the run's point of view, and the distinction is not worth keeping here:
       * what a person needs to know is that it is not coming back. A terminated run in particular
       * used to be indistinguishable from a queued one, which is the whole bug.
       */
      return 'failed';
    case 'RUNNING':
    case 'CONTINUED_AS_NEW':
      return 'running';
    default:
      // Unknown or unreachable. Say nothing rather than something wrong.
      return undefined;
  }
}

/**
 * Whether a run's record should be rewritten.
 *
 * Only ever moves a run OUT of a live state. A run already recorded as succeeded or failed is
 * settled, and re-deriving it from a workflow whose history may have expired would flip finished
 * work back to failed the moment Temporal forgot about it.
 */
export function reconcileRun(
  current: RunStatus,
  workflowStatus: string | undefined,
): RunStatus | undefined {
  if (!(LIVE_RUN_STATUSES as readonly string[]).includes(current)) return undefined;
  const next = statusFromWorkflow(workflowStatus);
  if (!next || next === current) return undefined;
  return next;
}

/**
 * A run whose workflow Temporal has never heard of.
 *
 * Distinct from "could not reach Temporal": a NOT_FOUND is an answer, and it means the workflow was
 * terminated and its history has aged out, or was never started at all. Either way the run is not
 * coming back, and leaving it queued is the failure this file exists to prevent.
 *
 * Gated on age, because a run started a second ago may legitimately not be visible yet.
 */
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
