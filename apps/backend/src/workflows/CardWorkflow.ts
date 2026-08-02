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
import type { UpdateCardArgs } from '../activities/UpdateCardActivity.js';
import type { ExecuteCardArgs, ExecuteCardResult } from '../activities/ExecuteCardActivity.js';
import { MAX_CARD_ATTEMPTS } from '../lib/board.js';
// From lib/activity-timeouts.ts, never the activity file — importing a VALUE from an activity
// pulls its whole dependency tree into this workflow's webpack bundle and Temporal's sandbox
// cannot handle Node built-ins. See that file's docstring for the incident.
import { executeCardActivityMeta, updateCardActivityMeta } from '../lib/activity-timeouts.js';

const { UpdateCardActivity } = proxyActivities<{ UpdateCardActivity: (args: UpdateCardArgs) => Promise<void> }>({
  startToCloseTimeout: updateCardActivityMeta.startToCloseTimeout,
});

/**
 * The card's actual work, with retries handled by TEMPORAL rather than by hand.
 *
 * Viable because ExecuteCardActivity takes only a cardId and rebuilds its context from Mongo each
 * attempt — and records the failure before throwing, so the retry reads a database the previous
 * attempt changed. Backoff, attempt counting and the cap all come free, and the workflow stops
 * carrying prompt-sized payloads in its history.
 */
const { ExecuteCardActivity } = proxyActivities<{ ExecuteCardActivity: (args: ExecuteCardArgs) => Promise<ExecuteCardResult> }>({
  startToCloseTimeout: executeCardActivityMeta.startToCloseTimeout,
  retry: {
    maximumAttempts: MAX_CARD_ATTEMPTS,
    initialInterval: '10 seconds',
    // Modest: a failing agent task is rarely fixed by waiting, and a long backoff just burns the
    // root card's wall-clock budget while nothing happens.
    backoffCoefficient: 2,
  },
});

export type WorkflowCardColumn = 'todo' | 'in-progress' | 'review';
export type WorkflowCardStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface CardWorkflowArgs {
  cardId: string;
  title: string;
  column: WorkflowCardColumn;
  /** Depth of THIS card. Children get depth + 1; the cap is enforced before signalling. */
  depth: number;
  // Deliberately NO context, prompt or failure history here. Those are read from Mongo by
  // ExecuteCardActivity at execution time, which is what makes Temporal's own retries useful and
  // keeps workflow history from carrying prompt-sized payloads.
}

export interface ChildRequest {
  cardId: string;
  title: string;
  /** Whether this parent waits for the child — see the ParentClosePolicy note below. */
  blocking: boolean;
  /** Position in the parent's child list. Makes the child's workflow id deterministic. */
  index: number;
}

export interface CardWorkflowState {
  column: WorkflowCardColumn;
  status: WorkflowCardStatus;
  blockingChildren: number;
}

export const moveCardSignal = defineSignal<[WorkflowCardColumn]>('moveCard');
/**
 * Marks the card's own work finished.
 *
 * Completion used to be "moved to the done column", which made the column both a location and a
 * lifecycle event — and duplicated `status: 'succeeded'`. Now a column is only ever where the work
 * currently sits, and finishing is its own signal: raised by the agent when its work succeeds, or
 * by a human for a card nobody is executing.
 */
export const completeCardSignal = defineSignal<[]>('completeCard');
export const cancelCardSignal = defineSignal<[]>('cancelCard');
export const addChildSignal = defineSignal<[ChildRequest]>('addChild');
export const cardStateQuery = defineQuery<CardWorkflowState>('cardState');

/**
 * One workflow per card — the execution half of "the board IS the state store".
 *
 * The database row is what the UI reads; this is what actually survives. A backend restart loses
 * nothing, because the card's live state is Temporal history rather than process memory, and
 * moving a card is a signal rather than a mutation someone has to remember to replay.
 *
 * Phase B has no personas, so a card's "work" is simply waiting to be moved to `done`. That is
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

export async function CardWorkflow(args: CardWorkflowArgs): Promise<CardWorkflowState> {
  let column: WorkflowCardColumn = args.column;
  let status: WorkflowCardStatus = 'running';
  let cancelled = false;
  let complete = false;

  /**
   * Blocking children only. A non-blocking child is follow-up work that outlives its parent, so
   * counting it here would mean a card could never finish — the same rule deriveCardStatus applies
   * on the read side, and the two must agree or the board will disagree with the workflow.
   */
  const blockingChildren: Promise<unknown>[] = [];
  /** Child ids already started, so a replayed or duplicated signal cannot spawn a second. */
  const startedChildren = new Set<number>();
  /** Requests queued by the addChild signal, drained by the loop below. */
  const pending: ChildRequest[] = [];

  setHandler(cardStateQuery, () => ({ column, status, blockingChildren: blockingChildren.length }));

  setHandler(moveCardSignal, (next) => {
    column = next;
  });

  setHandler(cancelCardSignal, () => {
    cancelled = true;
  });

  setHandler(completeCardSignal, () => {
    complete = true;
  });

  /**
   * Starts one child card.
   *
   * No retry loop here any more. Retries are Temporal's, on ExecuteCardActivity — see that file for
   * why taking only a cardId and reading context from Mongo is what makes native retries work.
   * Removing the loop also removed the attempt number from the child's workflow id, so the id is
   * once again purely (parent, index) and dedup is unambiguous.
   */
  function startCardChild(req: ChildRequest): Promise<unknown> {
    const child = startChild(CardWorkflow, {
      workflowId: `card-${args.cardId}-child-${req.index}`,
      args: [{ cardId: req.cardId, title: req.title, column: 'todo', depth: args.depth + 1 }],
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

  await UpdateCardActivity({ cardId: args.cardId, status: 'running', workflowId: workflowInfo().workflowId });

  /**
   * The card's own work, running alongside signal handling rather than blocking it — a card must
   * stay cancellable and stay able to accept sub-items while it is executing.
   *
   * Retries live inside this call (Temporal's policy on the activity), so a failure arriving here
   * means every attempt was already spent. `tokensUsed` is folded into the card's usage so the
   * root's budget sees real consumption rather than only wall-clock.
   */
  let ownWorkFailed: unknown;
  const ownWork = ExecuteCardActivity({ cardId: args.cardId })
    .then(async (result) => {
      if (result.tokensUsed > 0) {
        await UpdateCardActivity({ cardId: args.cardId, usage: { tokens: result.tokensUsed } });
      }
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
      const run = startCardChild(req);
      if (req.blocking) blockingChildren.push(run);
      // Detached: nothing will ever await it, so swallow rejections or a failing follow-up task
      // becomes an unhandled rejection that fails the PARENT — the opposite of non-blocking.
      else run.catch(() => {});
    }
    if (cancelled || complete) break;
  }

  if (cancelled) {
    status = 'cancelled';
    await UpdateCardActivity({ cardId: args.cardId, status });
    return { column, status, blockingChildren: blockingChildren.length };
  }

  // Settle the work promise before judging the outcome: `complete` may have been set by the
  // catch handler above, and reading ownWorkFailed before it resolves would miss the failure.
  await ownWork;
  if (ownWorkFailed) {
    status = 'failed';
    // The failure detail is already on the card — ExecuteCardActivity wrote it before throwing,
    // on every attempt, which is what the next retry reads.
    await UpdateCardActivity({ cardId: args.cardId, status });
    return { column, status, blockingChildren: blockingChildren.length };
  }

  // The card's own work is finished; now wait for anything it explicitly blocked on. Ordering
  // matters: waiting first would mean a card could not be marked done until its children were,
  // which is backwards for "split this up, then integrate".
  if (blockingChildren.length > 0) {
    const results = await Promise.allSettled(blockingChildren);
    if (results.some((r) => r.status === 'rejected')) {
      status = 'failed';
      await UpdateCardActivity({ cardId: args.cardId, status });
      return { column, status, blockingChildren: blockingChildren.length };
    }
  }

  status = 'succeeded';
  await UpdateCardActivity({ cardId: args.cardId, status, column });
  return { column, status, blockingChildren: blockingChildren.length };
}
