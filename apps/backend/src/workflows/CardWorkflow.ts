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

  setHandler(cardStateQuery, () => ({ column, status, blockingChildren: blockingChildren.length }));

  setHandler(moveCardSignal, (next) => {
    column = next;
  });

  setHandler(cancelCardSignal, () => {
    cancelled = true;
  });

  setHandler(addChildSignal, (req) => {
    // Signals cannot be async, so this starts the child and keeps the promise rather than awaiting.
    if (startedChildren.has(req.index)) return;
    startedChildren.add(req.index);

    // `.then(h => h.result())` is load-bearing. startChild() resolves as soon as the child has
    // STARTED, not when it finishes — awaiting it directly made Promise.allSettled below return
    // immediately, so the parent completed while its blocking child was still in 'todo', and the
    // TERMINATE policy then killed that child. Verified live before this was corrected.
    const child = startChild(CardWorkflow, {
      // Deterministic, derived from the parent and the child's position. Temporal's own
      // workflow-id dedup then makes a retried or duplicated signal a no-op instead of spawning a
      // second child — which would mean duplicate cards AND duplicate workspace pods later.
      workflowId: `card-${args.cardId}-child-${req.index}`,
      args: [{ cardId: req.cardId, title: req.title, column: 'todo', depth: args.depth + 1 }],
      // ABANDON for non-blocking children is the whole point of the distinction: "I found
      // follow-up work" must survive its parent closing. Blocking children are terminated with the
      // parent, since nothing will consume their result.
      parentClosePolicy: req.blocking ? ParentClosePolicy.TERMINATE : ParentClosePolicy.ABANDON,
    });

    if (req.blocking) {
      blockingChildren.push(child.then((handle) => handle.result()));
    } else {
      // Detached: nothing will ever await it, so swallow rejections here or a failing follow-up
      // task becomes an unhandled rejection that fails the PARENT — the opposite of non-blocking.
      child.catch(() => {});
    }
  });

  await UpdateCardActivity({ cardId: args.cardId, status: 'running', workflowId: workflowInfo().workflowId });

  // Done when the card reaches the done column, or someone cancels it.
  await condition(() => cancelled || column === 'done');

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
