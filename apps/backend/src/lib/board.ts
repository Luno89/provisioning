/**
 * The kanban board — agent harness Phase B (~/.claude/plans/agent-harness.md).
 *
 * The board is the STATE STORE, not a view over one. Each card in an active column maps to a
 * Temporal workflow; moving a card signals it. That single decision is what makes pause, retry and
 * reassign into workflow operations, and what makes agent runs survive a backend restart — which is
 * otherwise one of the hardest parts of building an agent system.
 *
 * This module is deliberately pure. Everything here is a rule about hierarchy, status or budget,
 * with no I/O, because these are the parts that are easy to get subtly wrong and expensive to
 * debug once real work is running through them.
 */

export type CardColumn = 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';

/**
 * Execution state, distinct from `column`. A card sits in a column because someone (or a persona)
 * put it there; its status reflects what the workflow actually did. Conflating them means a failed
 * run silently looks like work in progress.
 */
export type CardStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Card {
  id: string;
  ownerId: string;
  boardId: string;
  title: string;
  body?: string;
  column: CardColumn;
  status: CardStatus;

  /** Absent on a root card. */
  parentCardId?: string;
  /** 0 for a root card. Capped — see MAX_DEPTH. */
  depth: number;
  /**
   * Whether the parent waits for this child.
   *
   * true  — "split this into three, then integrate": the parent's status derives from it.
   * false — "I found follow-up work": the child outlives the parent and never blocks it.
   */
  blocking: boolean;

  personaId?: string;
  /** The Temporal workflow backing this card, once started. */
  workflowId?: string;
  projectId?: string;
  branch?: string;
  /** Root cards only — the budget governing this card AND its whole subtree. */
  budget?: CardBudget;

  createdAt: string;
  updatedAt: string;
}

/**
 * Cost ceiling for a root card and everything beneath it.
 *
 * Deliberately on the ROOT rather than per card. Depth and fan-out caps alone still permit
 * 3 × 10 × 10 = 300 workspaces; only a subtree-wide budget actually bounds spend. It is also the
 * concrete mitigation for an injected "create 10,000 subtasks" — the prompt-injection risk in the
 * plan is not hypothetical once an agent reads a repo it did not write.
 */
export interface CardBudget {
  maxTokens?: number;
  maxWallClockMs?: number;
  maxWorkspaces?: number;
  /** Replans count too. A planner that responds to failure by generating more work is a loop. */
  maxReplans?: number;
}

export interface BudgetUsage {
  tokens: number;
  wallClockMs: number;
  workspaces: number;
  replans: number;
}

/** Three levels is enough to express "epic → task → subtask" and stops runaway decomposition. */
export const MAX_DEPTH = 3;
/** Per-card fan-out. Combined with MAX_DEPTH this bounds the subtree; the budget bounds the cost. */
export const MAX_CHILDREN_PER_CARD = 10;

/**
 * Why a child may not be added, or undefined if it may.
 *
 * Returns a reason rather than a boolean so the refusal can be shown to the user (and fed back to
 * the agent that asked), instead of a silent no-op that looks like the request was lost.
 */
export function canAddChild(parent: Pick<Card, 'depth'>, existingChildren: number): string | undefined {
  if (parent.depth + 1 > MAX_DEPTH) {
    return `Maximum nesting depth of ${MAX_DEPTH} reached — break the work down differently rather than deeper`;
  }
  if (existingChildren >= MAX_CHILDREN_PER_CARD) {
    return `A card may have at most ${MAX_CHILDREN_PER_CARD} sub-items`;
  }
  return undefined;
}

/** Why the budget is spent, or undefined if there is room. */
export function budgetExceeded(budget: CardBudget | undefined, usage: BudgetUsage): string | undefined {
  if (!budget) return undefined;
  if (budget.maxTokens !== undefined && usage.tokens >= budget.maxTokens) {
    return `Token budget exhausted (${usage.tokens}/${budget.maxTokens})`;
  }
  if (budget.maxWallClockMs !== undefined && usage.wallClockMs >= budget.maxWallClockMs) {
    return `Time budget exhausted (${Math.round(usage.wallClockMs / 60000)} minutes)`;
  }
  if (budget.maxWorkspaces !== undefined && usage.workspaces >= budget.maxWorkspaces) {
    return `Workspace budget exhausted (${usage.workspaces}/${budget.maxWorkspaces})`;
  }
  if (budget.maxReplans !== undefined && usage.replans >= budget.maxReplans) {
    return `Replan budget exhausted (${usage.replans}/${budget.maxReplans}) — the plan is not converging`;
  }
  return undefined;
}

/**
 * A card's effective status, derived from its blocking children when it has any.
 *
 * Only BLOCKING children count. A non-blocking child is follow-up work that outlives its parent,
 * so letting it drag the parent back to "running" would mean a card could never finish.
 *
 * The card's own failure always wins: if the work it was doing itself failed, children succeeding
 * does not redeem it.
 */
export function deriveCardStatus(own: CardStatus, children: Pick<Card, 'status' | 'blocking'>[]): CardStatus {
  if (own === 'failed' || own === 'cancelled') return own;

  const blocking = children.filter((c) => c.blocking);
  if (blocking.length === 0) return own;

  if (blocking.some((c) => c.status === 'failed')) return 'failed';
  if (blocking.some((c) => c.status === 'pending' || c.status === 'running')) return 'running';
  // Every blocking child finished. The parent is only done when its OWN work is too — otherwise a
  // card whose children raced ahead would report success while it had not started integrating.
  if (blocking.every((c) => c.status === 'cancelled')) return own === 'succeeded' ? 'succeeded' : 'cancelled';
  return own === 'succeeded' ? 'succeeded' : 'running';
}

/**
 * Deterministic Temporal workflow id for a child card.
 *
 * MUST be deterministic, and this is the single easiest thing to get wrong here. Activities retry;
 * a partially-succeeded "create subtask" step with random ids produces duplicate cards AND
 * duplicate workspace pods. Deriving the id from (parent, index) makes Temporal's own workflow-id
 * dedup do the work — a retry addresses the same child rather than spawning a second.
 *
 * Index-based rather than content-hashed on purpose. A hash collides whenever a planner legitimately
 * emits two identically-titled subtasks ("write tests"), which is common. Index is safe because the
 * caller must record the planner's proposed children as an ACTIVITY RESULT first: Temporal persists
 * and replays that list identically, so the ordering cannot drift between attempts even though the
 * model that produced it is non-deterministic.
 */
export function childWorkflowId(parentCardId: string, index: number): string {
  return `card-${parentCardId}-child-${index}`;
}

/** Cards whose parent is `parentId`, in stable creation order. */
export function childrenOf(cards: Card[], parentId: string): Card[] {
  return cards
    .filter((c) => c.parentCardId === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Walks up to the root card, which is where the budget lives.
 *
 * Returns undefined if the chain is broken (a parent id pointing at a card that no longer exists),
 * rather than looping — a cycle or dangling reference must not hang the caller.
 */
export function rootCard(cards: Card[], card: Card): Card | undefined {
  const byId = new Map(cards.map((c) => [c.id, c]));
  let current: Card | undefined = card;
  for (let i = 0; i <= MAX_DEPTH + 1 && current; i++) {
    if (!current.parentCardId) return current;
    current = byId.get(current.parentCardId);
  }
  return undefined;
}

/** Every descendant of a card, for aggregating usage against the root budget. */
export function subtreeOf(cards: Card[], rootId: string): Card[] {
  const out: Card[] = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue; // guards against a cycle rather than spinning forever
    seen.add(id);
    for (const child of cards.filter((c) => c.parentCardId === id)) {
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}
