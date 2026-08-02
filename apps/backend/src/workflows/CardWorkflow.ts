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
import type { CardAttempt } from '../lib/board.js';
import { shouldRetry } from '../lib/board.js';
// From lib/activity-timeouts.ts, never the activity file — importing a VALUE from an activity
// pulls its whole dependency tree into this workflow's webpack bundle and Temporal's sandbox
// cannot handle Node built-ins. See that file's docstring for the incident.
import { updateCardActivityMeta } from '../lib/activity-timeouts.js';

const { UpdateCardActivity } = proxyActivities<{ UpdateCardActivity: (args: UpdateCardArgs) => Promise<void> }>({
  startToCloseTimeout: updateCardActivityMeta.startToCloseTimeout,
});

export type WorkflowCardColumn = 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
export type WorkflowCardStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface CardWorkflowArgs {
  cardId: string;
  title: string;
  column: WorkflowCardColumn;
  /** Depth of THIS card. Children get depth + 1; the cap is enforced before signalling. */
  depth: number;
  /**
   * Failures from earlier attempts at this same card, oldest first.
   *
   * Phase B has no persona to feed these to, so nothing reads them yet — but they are carried here
   * rather than only stored on the row because this is the value a persona's prompt gets built
   * from (see failureContext). The plumbing exists so Phase C adds a prompt, not a data model.
   */
  priorFailures?: CardAttempt[];
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

  /**
   * Runs one child to completion, retrying with the previous failures fed into its context.
   *
   * NOT Temporal's built-in retry policy, deliberately. That replays identical input, so an agent
   * task would fail the same way every attempt — the only reason retrying is worth anything here is
   * that attempt N+1 is told why attempt N failed. Each attempt is therefore a fresh child workflow
   * carrying an accumulated failure history.
   *
   * The attempt number is part of the workflow id, so dedup still holds: a duplicated addChild
   * signal cannot spawn a second child, but a genuine retry is a distinct execution rather than
   * being silently deduped into the failed one.
   */
  async function runChildWithRetries(req: ChildRequest): Promise<void> {
    const failures: CardAttempt[] = [];

    for (let attempt = 0; ; attempt++) {
      const handle = await startChild(CardWorkflow, {
        workflowId: `card-${args.cardId}-child-${req.index}-a${attempt}`,
        args: [{
          cardId: req.cardId,
          title: req.title,
          column: 'todo',
          depth: args.depth + 1,
          // What makes the retry worth attempting. Empty on the first try.
          priorFailures: failures.slice(),
        }],
        // ABANDON for non-blocking children is the whole point of the distinction: "I found
        // follow-up work" must survive its parent closing. Blocking children are terminated with
        // the parent, since nothing will consume their result.
        parentClosePolicy: req.blocking ? ParentClosePolicy.TERMINATE : ParentClosePolicy.ABANDON,
      });

      try {
        // `handle.result()` is load-bearing: startChild() resolves as soon as the child has
        // STARTED, not when it finishes. Awaiting it directly made the parent complete while its
        // blocking child was still in 'todo', and TERMINATE then killed that child.
        await handle.result();
        return;
      } catch (err: any) {
        failures.push({
          attempt,
          error: describeFailure(err),
          failedAt: new Date().toISOString(),
        });
        // Persisted as it happens, not at the end: the board should show a card failing and being
        // retried while it is happening, and a parent that dies mid-retry must not take the record
        // of why with it.
        await UpdateCardActivity({ cardId: req.cardId, status: 'failed', attempts: failures.slice() });

        if (!shouldRetry(failures.length)) throw err;
      }
    }
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

  // Done when the card reaches the done column, or someone cancels it — but children queued by
  // signals must be started meanwhile, which is why this is a loop rather than a single condition.
  for (;;) {
    await condition(() => cancelled || column === 'done' || pending.length > 0);
    while (pending.length > 0) {
      const req = pending.shift()!;
      const run = runChildWithRetries(req);
      if (req.blocking) blockingChildren.push(run);
      // Detached: nothing will ever await it, so swallow rejections or a failing follow-up task
      // becomes an unhandled rejection that fails the PARENT — the opposite of non-blocking.
      else run.catch(() => {});
    }
    if (cancelled || column === 'done') break;
  }

  if (cancelled) {
    status = 'cancelled';
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
