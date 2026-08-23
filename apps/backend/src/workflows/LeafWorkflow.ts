import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  startChild,
  ParentClosePolicy,
  workflowInfo,
} from '@temporalio/workflow';
import type { UpdateLeafArgs } from '../activities/UpdateLeafActivity.js';
import type { ExecuteLeafArgs, ExecuteLeafResult } from '../activities/ExecuteLeafActivity.js';
import type { LeafGateArgs, LeafGateResult, ReleaseDependentsResult } from '../activities/LeafGateActivity.js';
import type { LandRequestArgs, LandRequestResult } from '../activities/LandRequestActivity.js';
import type { ResolveLandingArgs, ResolveLandingResult } from '../activities/ResolveLandingActivity.js';
import type { AcceptRequestArgs, AcceptRequestResult } from '../activities/AcceptRequestActivity.js';
import type { ReplanArgs, ReplanResult } from '../activities/ReplanActivity.js';
import type { JudgeLeafArgs, JudgeLeafResult } from '../activities/JudgeLeafActivity.js';
import { MAX_LEAF_ATTEMPTS } from '../lib/leaves.js';
// From lib/activity-timeouts.ts, never the activity file — importing a VALUE from an activity
// pulls its whole dependency tree into this workflow's webpack bundle and Temporal's sandbox
// cannot handle Node built-ins. See that file's docstring for the incident.
import { executeLeafActivityMeta, updateLeafActivityMeta, checkLeafGateActivityMeta, releaseDependentsActivityMeta, landRequestActivityMeta, resolveLandingActivityMeta, acceptRequestActivityMeta, replanActivityMeta, judgeLeafActivityMeta,
} from '../lib/activity-timeouts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { UpdateLeafActivity } = proxyActivities<{ UpdateLeafActivity: (args: UpdateLeafArgs) => Promise<void> }>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: updateLeafActivityMeta.startToCloseTimeout,
});

/**
 * The leaf's actual work, with retries handled by TEMPORAL rather than by hand.
 *
 * Viable because ExecuteLeafActivity takes only a leafId and rebuilds its context from Mongo each
 * attempt — and records the failure before throwing, so the retry reads a database the previous
 * attempt changed. Backoff, attempt counting and the cap all come free, and the workflow stops
 * carrying prompt-sized payloads in its history.
 */
const { ExecuteLeafActivity } = proxyActivities<{ ExecuteLeafActivity: (args: ExecuteLeafArgs) => Promise<ExecuteLeafResult> }>({
  startToCloseTimeout: executeLeafActivityMeta.startToCloseTimeout,
  // Read from the meta, not restated: a heartbeat the activity sends and the call site never asks
  // for is not a timeout, it is a no-op, and the two numbers would drift silently apart.
  heartbeatTimeout: executeLeafActivityMeta.heartbeatTimeout,
  retry: {
    maximumAttempts: MAX_LEAF_ATTEMPTS,
    initialInterval: '10 seconds',
    // Modest: a failing agent task is rarely fixed by waiting, and a long backoff just burns the
    // root leaf's wall-clock budget while nothing happens.
    backoffCoefficient: 2,
  },
});

/**
 * The dependency gate and the release, both activities so the rules are not replay-bound.
 *
 * Retried by Temporal, which is the whole reason the release can replace a polling loop: a worker
 * that dies mid-release resumes it, so the event cannot be silently lost the way an in-process
 * event can. See activities/LeafGateActivity.ts.
 */
const { CheckLeafGateActivity } = proxyActivities<{ CheckLeafGateActivity: (args: LeafGateArgs) => Promise<LeafGateResult> }>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: checkLeafGateActivityMeta.startToCloseTimeout,
});

const { ReleaseDependentsActivity } = proxyActivities<{ ReleaseDependentsActivity: (args: LeafGateArgs) => Promise<ReleaseDependentsResult> }>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: releaseDependentsActivityMeta.startToCloseTimeout,
});

/**
 * The judge. One attempt, because a review is a convenience rather than a step of the work — see
 * JudgeLeafActivity. Retrying it would spend a model call to re-answer a question nothing is
 * waiting on.
 */
const { JudgeLeafActivity } = proxyActivities<{ JudgeLeafActivity: (args: JudgeLeafArgs) => Promise<JudgeLeafResult> }>({
  startToCloseTimeout: judgeLeafActivityMeta.startToCloseTimeout,
  retry: { maximumAttempts: 1 },
});

/**
 * The end-of-request sweep. A no-op until this leaf was the last one still moving, so it is safe to
 * call from every leaf rather than trying to work out which one is last — that question has no
 * stable answer while dependents are still being released.
 */
const { LandRequestActivity } = proxyActivities<{ LandRequestActivity: (args: LandRequestArgs) => Promise<LandRequestResult> }>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: landRequestActivityMeta.startToCloseTimeout,
});

/**
 * The agent-assisted merge, run only when the plain one left work stuck. Retries are off: a
 * conflict the agent could not resolve will not resolve differently on a second identical attempt,
 * and each one costs a workspace and a model loop.
 */
const { ResolveLandingActivity } = proxyActivities<{ ResolveLandingActivity: (args: ResolveLandingArgs) => Promise<ResolveLandingResult> }>({
  startToCloseTimeout: resolveLandingActivityMeta.startToCloseTimeout,
  retry: { maximumAttempts: 1 },
});

/**
 * Runs the delivered thing once the whole request has landed. Not retried: a deliverable that does
 * not work will not work on a second identical run, and each attempt boots a workspace.
 */
const { ReplanActivity } = proxyActivities<{ ReplanActivity: (args: ReplanArgs) => Promise<ReplanResult> }>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: replanActivityMeta.startToCloseTimeout,
});
const { AcceptRequestActivity } = proxyActivities<{ AcceptRequestActivity: (args: AcceptRequestArgs) => Promise<AcceptRequestResult> }>({
  startToCloseTimeout: acceptRequestActivityMeta.startToCloseTimeout,
  retry: { maximumAttempts: 1 },
});

export type WorkflowLeafColumn = 'todo' | 'in-progress' | 'review';
export type WorkflowLeafStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface LeafWorkflowArgs {
  leafId: string;
  title: string;
  column: WorkflowLeafColumn;
  /** Depth of THIS leaf. Children get depth + 1; the cap is enforced before signalling. */
  depth: number;
  // Deliberately NO context, prompt or failure history here. Those are read from Mongo by
  // ExecuteLeafActivity at execution time, which is what makes Temporal's own retries useful and
  // keeps workflow history from carrying prompt-sized payloads.
}

export interface ChildRequest {
  leafId: string;
  title: string;
  /** Whether this parent waits for the child — see the ParentClosePolicy note below. */
  blocking: boolean;
  /** Position in the parent's child list. Makes the child's workflow id deterministic. */
  index: number;
}

export interface LeafWorkflowState {
  column: WorkflowLeafColumn;
  status: WorkflowLeafStatus;
  blockingChildren: number;
}

export const moveLeafSignal = defineSignal<[WorkflowLeafColumn]>('moveLeaf');
/**
 * Marks the leaf's own work finished.
 *
 * Completion used to be "moved to the done column", which made the column both a location and a
 * lifecycle event — and duplicated `status: 'succeeded'`. Now a column is only ever where the work
 * currently sits, and finishing is its own signal: raised by the agent when its work succeeds, or
 * by a human for a leaf nobody is executing.
 */
export const completeLeafSignal = defineSignal<[]>('completeLeaf');
export const cancelLeafSignal = defineSignal<[]>('cancelLeaf');
export const addChildSignal = defineSignal<[ChildRequest]>('addChild');
/**
 * Raised by a dependency when it finishes, successfully or not.
 *
 * Carries the finished leaf's id for the log only — readiness is re-read from the board rather than
 * derived from which signals have arrived. Counting arrivals would go wrong the moment the plan is
 * edited mid-flight, and would double-count a dependency whose release activity was retried.
 */
export const dependencyCompletedSignal = defineSignal<[string]>('dependencyCompleted');
export const leafStateQuery = defineQuery<LeafWorkflowState>('leafState');

/**
 * One workflow per leaf — the execution half of "the board IS the state store".
 *
 * The database row is what the UI reads; this is what actually survives. A backend restart loses
 * nothing, because the leaf's live state is Temporal history rather than process memory, and
 * moving a leaf is a signal rather than a mutation someone has to remember to replay.
 *
 * Phase B has no personas, so a leaf's "work" is simply waiting to be moved to `done`. That is
 * deliberately unglamorous: it exercises durability, signalling, child fan-out and cancellation
 * end to end, so the agent work in later phases plugs into a shape that already holds up.
 */
/**
 * Flattens Temporal's wrapped failures into something a retry can actually learn from.
 *
 * A child failure arrives as ChildWorkflowFailure — whose own message is the useless
 * "Child Workflow execution failed" — with the real reason buried in `.cause`, sometimes two
 * levels down (ChildWorkflowFailure → ActivityFailure → ApplicationFailure). Recording only the
 * top-level message hands the next attempt no information, which defeats the entire reason these
 * retries are not Temporal's built-in ones.
 */
function describeFailure(err: unknown): string {
  const parts: string[] = [];
  let current: any = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const message = typeof current === 'string' ? current : current?.message;
    // Skip the generic wrappers; they add length without adding information.
    if (message && !/^(Child Workflow execution failed|Activity task failed)$/.test(message)) {
      parts.push(String(message));
    }
    current = current?.cause;
  }
  return (parts.join(': ') || String((err as any)?.message ?? err)).slice(0, 2000);
}

export async function LeafWorkflow(args: LeafWorkflowArgs): Promise<LeafWorkflowState> {
  let column: WorkflowLeafColumn = args.column;
  let status: WorkflowLeafStatus = 'running';
  let cancelled = false;
  let complete = false;

  /**
   * Blocking children only. A non-blocking child is follow-up work that outlives its parent, so
   * counting it here would mean a leaf could never finish — the same rule deriveLeafStatus applies
   * on the read side, and the two must agree or the board will disagree with the workflow.
   */
  const blockingChildren: Promise<unknown>[] = [];
  /** Child ids already started, so a replayed or duplicated signal cannot spawn a second. */
  const startedChildren = new Set<number>();
  /** Requests queued by the addChild signal, drained by the loop below. */
  const pending: ChildRequest[] = [];

  setHandler(leafStateQuery, () => ({ column, status, blockingChildren: blockingChildren.length }));

  setHandler(moveLeafSignal, (next) => {
    column = next;
  });

  setHandler(cancelLeafSignal, () => {
    cancelled = true;
  });

  setHandler(completeLeafSignal, () => {
    complete = true;
  });

  /**
   * Starts one child leaf.
   *
   * No retry loop here any more. Retries are Temporal's, on ExecuteLeafActivity — see that file for
   * why taking only a leafId and reading context from Mongo is what makes native retries work.
   * Removing the loop also removed the attempt number from the child's workflow id, so the id is
   * once again purely (parent, index) and dedup is unambiguous.
   */
  function startLeafChild(req: ChildRequest): Promise<unknown> {
    const child = startChild(LeafWorkflow, {
      workflowId: `leaf-${args.leafId}-child-${req.index}`,
      args: [{ leafId: req.leafId, title: req.title, column: 'todo', depth: args.depth + 1 }],
      // ABANDON for non-blocking children is the whole point of the distinction: "I found
      // follow-up work" must survive its parent closing. Blocking children are terminated with the
      // parent, since nothing will consume their result.
      parentClosePolicy: req.blocking ? ParentClosePolicy.TERMINATE : ParentClosePolicy.ABANDON,
    });
    // `handle.result()` is load-bearing: startChild() resolves as soon as the child has STARTED,
    // not when it finishes. Awaiting it directly made the parent complete while its blocking child
    // was still running, and TERMINATE then killed that child.
    return child.then((handle) => handle.result());
  }

  setHandler(addChildSignal, (req) => {
    // Signal handlers cannot be async, so this queues the request and the main loop starts it.
    // Starting it here would also mean the retry loop above ran inside a signal handler, which is
    // exactly where Temporal's determinism guarantees get hard to reason about.
    if (startedChildren.has(req.index)) return;
    startedChildren.add(req.index);
    pending.push(req);
  });

  /**
   * ── THE DEPENDENCY GATE ──
   *
   * The workflow id is claimed immediately but the status stays `pending`, because a leaf parked
   * on its dependencies is not running and must not look like it is. Claiming the id first is what
   * stops anything starting a second execution: `readyToStart` skips a leaf that already has one.
   */
  await UpdateLeafActivity({ leafId: args.leafId, workflowId: workflowInfo().workflowId });

  /** Set by a dependency finishing. Only a nudge to re-read — never counted. */
  let dependencyFinished = false;
  setHandler(dependencyCompletedSignal, () => {
    dependencyFinished = true;
  });

  let gate = await CheckLeafGateActivity({ leafId: args.leafId });
  /**
   * Stops a completing dependency from resurrecting work nobody asked for.
   *
   * `signalWithStart` starts a workflow whose id names a CLOSED execution, so without this a leaf
   * that was cancelled — or has already run — would come back to life the moment something it
   * depended on finished. `stop` leaves the row exactly as it was found.
   */
  if (gate.decision === 'stop') return { column, status: 'cancelled', blockingChildren: 0 };

  while (gate.decision === 'wait' && !cancelled) {
    /**
     * Waiting is an OPEN WORKFLOW, not a row nobody is acting on.
     *
     * This replaced a 30-second sweep that re-derived readiness for every leaf on the board. That
     * cost up to half a minute per edge — a five-step chain averaged about 75 seconds of pure
     * waiting — and ran forever whether or not anything was blocked. Parked here the leaf costs
     * nothing, wakes the instant its last dependency lands, and its state is queryable.
     */
    await condition(() => cancelled || dependencyFinished);
    if (cancelled) break;
    dependencyFinished = false;
    // Re-read rather than assume this was the last one: a leaf with two dependencies is woken by
    // each of them, and the board may have been edited while it waited.
    gate = await CheckLeafGateActivity({ leafId: args.leafId });
    if (gate.decision === 'stop') return { column, status: 'cancelled', blockingChildren: 0 };
  }

  /**
   * A dependency was cancelled, so this can never run. Marked cancelled and released rather than
   * left parked: an open workflow waiting on a signal that is never coming is invisible except as
   * a card that never moves, and anything waiting on THIS leaf would inherit the same fate.
   */
  if (gate.decision === 'abandon') {
    await UpdateLeafActivity({ leafId: args.leafId, status: 'cancelled' });
    await ReleaseDependentsActivity({ leafId: args.leafId });
    return { column, status: 'cancelled', blockingChildren: 0 };
  }

  if (cancelled) {
    await UpdateLeafActivity({ leafId: args.leafId, status: 'cancelled' });
    await ReleaseDependentsActivity({ leafId: args.leafId });
    return { column, status: 'cancelled', blockingChildren: 0 };
  }

  await UpdateLeafActivity({ leafId: args.leafId, status: 'running' });

  /**
   * The leaf's own work, running alongside signal handling rather than blocking it — a leaf must
   * stay cancellable and stay able to accept sub-items while it is executing.
   *
   * Retries live inside this call (Temporal's policy on the activity), so a failure arriving here
   * means every attempt was already spent.
   *
   * ── USAGE IS NOT RECORDED HERE ──
   * It used to be, and it double-counted every succeeded leaf. ExecuteLeafActivity already folds
   * `run.tokensUsed` into `leaf.usage` and persists it on BOTH exit paths, so adding the returned
   * total again here counted the successful path twice while the failing path — which throws, and
   * never reaches this callback — counted once. Measured against the Personas "Typical tokens"
   * column, which reported roughly double for every verified persona.
   *
   * The activity is the authoritative writer precisely because it is the only one that sees a
   * failed attempt. `UpdateLeafArgs.usage` stays additive for the callers that do report new
   * spend a piece at a time.
   */
  let ownWorkFailed: unknown;
  const ownWork = ExecuteLeafActivity({ leafId: args.leafId })
    .then(() => {
      complete = true;
    })
    .catch((err) => {
      ownWorkFailed = err;
      complete = true;
    });

  for (;;) {
    await condition(() => cancelled || complete || pending.length > 0);
    while (pending.length > 0) {
      const req = pending.shift()!;
      const run = startLeafChild(req);
      if (req.blocking) blockingChildren.push(run);
      // Detached: nothing will ever await it, so swallow rejections or a failing follow-up task
      // becomes an unhandled rejection that fails the PARENT — the opposite of non-blocking.
      else run.catch(() => {});
    }
    if (cancelled || complete) break;
  }

  if (cancelled) {
    status = 'cancelled';
    await UpdateLeafActivity({ leafId: args.leafId, status });
    await ReleaseDependentsActivity({ leafId: args.leafId });
    await LandRequestActivity({ leafId: args.leafId });
    return { column, status, blockingChildren: blockingChildren.length };
  }

  // Settle the work promise before judging the outcome: `complete` may have been set by the
  // catch handler above, and reading ownWorkFailed before it resolves would miss the failure.
  await ownWork;
  if (ownWorkFailed) {
    status = 'failed';
    // The failure detail is already on the leaf — ExecuteLeafActivity wrote it before throwing,
    // on every attempt, which is what the next retry reads.
    await UpdateLeafActivity({ leafId: args.leafId, status });
    /**
     * Released on FAILURE too, not only success.
     *
     * A dependent whose dependency failed will never satisfy `dependenciesMet` and must not start
     * — but it still has to be WOKEN to find that out. Skipping this is how a diamond with one
     * failed arm strands the other arm's dependents on a signal that never arrives.
     */
    await ReleaseDependentsActivity({ leafId: args.leafId });
    await LandRequestActivity({ leafId: args.leafId });
    return { column, status, blockingChildren: blockingChildren.length };
  }

  // The leaf's own work is finished; now wait for anything it explicitly blocked on. Ordering
  // matters: waiting first would mean a leaf could not be marked done until its children were,
  // which is backwards for "split this up, then integrate".
  if (blockingChildren.length > 0) {
    const results = await Promise.allSettled(blockingChildren);
    if (results.some((r) => r.status === 'rejected')) {
      status = 'failed';
      await UpdateLeafActivity({ leafId: args.leafId, status });
      await ReleaseDependentsActivity({ leafId: args.leafId });
      await LandRequestActivity({ leafId: args.leafId });
      return { column, status, blockingChildren: blockingChildren.length };
    }
  }

  status = 'succeeded';
  /**
   * Moved to `review`, because finished work is not still To Do.
   *
   * `column` here is whatever the workflow STARTED with — it changes only when a human drags the
   * card. `ExecuteLeafActivity` already writes `review` when the work succeeds, and this write
   * lands after it, so the stale value overwrote the fresh one and a completed leaf reappeared in
   * To Do. Measured on a real run: 144,044 tokens spent, zero failed attempts, and the card looked
   * untouched.
   *
   * Set here rather than dropped from the write, so the workflow's own state query agrees with the
   * board instead of the two quietly diverging again.
   */
  column = 'review';
  await UpdateLeafActivity({ leafId: args.leafId, status, column });
  /**
   * Wakes whatever was waiting on this leaf — the event that replaced the 30-second sweep.
   *
   * LAST, after the board says `succeeded`: a dependent woken any earlier would re-read the board,
   * still see this leaf unfinished, and go straight back to waiting for a signal that has already
   * been sent.
   */
  await ReleaseDependentsActivity({ leafId: args.leafId });
  /**
   * Sweeps up anything verified that never reached the default branch — see LandRequestActivity.
   * A no-op unless this leaf was the last one still moving, so it is safe to call from every exit
   * rather than trying to identify the last leaf, which has no stable answer while dependents are
   * still being released.
   */
  /**
   * A second opinion on work nothing could check.
   *
   * Placed here — after the board says `succeeded`, before landing — because it reads the evidence
   * `ExecuteLeafActivity` captured and nothing downstream depends on its answer. It decides for
   * itself whether this leaf is in its population (a success no deterministic layer confirmed), so
   * the workflow does not have to ask.
   *
   * Never fatal, and not awaited for its verdict beyond logging: a judge that is down leaves a leaf
   * in exactly the state it was in before judges existed. `maximumAttempts: 1` because a review is
   * not worth retrying — if the endpoint was busy, the answer can be backfilled later.
   */
  await JudgeLeafActivity({ leafId: args.leafId }).catch(() => undefined);

  const landing = await LandRequestActivity({ leafId: args.leafId });
  // Only when the mechanical merge left something behind. Every other exit path is a leaf that
  // failed or was cancelled, where there is nothing verified to land.
  if (landing.stuck.length > 0) await ResolveLandingActivity({ leafId: args.leafId });
  // Last, and only after everything is on the default branch: the point is to run what the user
  // would actually get, not this leaf's branch.
  await AcceptRequestActivity({ leafId: args.leafId });
  /**
   * A planning turn, once nothing is waiting on this leaf.
   *
   * After acceptance, so the planner sees a verdict on the assembled result rather than deciding
   * against work that has not been checked yet. `ReplanActivity` decides for itself whether this
   * leaf is on the frontier and whether the budget allows it — a leaf in the middle of a chain
   * needs no turn, because releasing its dependents already IS the next step.
   *
   * It may only propose work. Completion is decided by the acceptance checks above.
   */
  await ReplanActivity({ leafId: args.leafId });
  return { column, status, blockingChildren: blockingChildren.length };
}
