/**
 * The kanban board — agent harness Phase B (~/.claude/plans/agent-harness.md).
 *
 * The board is the STATE STORE, not a view over one. Each leaf in an active column maps to a
 * Temporal workflow; moving a leaf signals it. That single decision is what makes pause, retry and
 * reassign into workflow operations, and what makes agent runs survive a backend restart — which is
 * otherwise one of the hardest parts of building an agent system.
 *
 * This module is deliberately pure. Everything here is a rule about hierarchy, status or budget,
 * with no I/O, because these are the parts that are easy to get subtly wrong and expensive to
 * debug once real work is running through them.
 */

/**
 * Work states only. There is deliberately no 'backlog' or 'done':
 *
 * - A leaf exists because a request needed it, so there is no waiting-room to park it in. Work
 *   that is not wanted yet is a leaf that has not been created.
 * - 'done' duplicated `status: 'succeeded'`, and two sources of truth for completion drift. A
 *   finished leaf leaves the columns entirely rather than piling up in one.
 */
export type LeafColumn = 'todo' | 'in-progress' | 'review';

/**
 * The columns, as a runtime value.
 *
 * The union type above validates nothing at a request boundary — `column` arrives as untrusted
 * JSON, so a removed column like 'done' was accepted with a 201 and written straight to the
 * database until this existed, leaving a leaf in a state the UI cannot render or move it out of.
 */
export const LEAF_COLUMNS: readonly LeafColumn[] = ['todo', 'in-progress', 'review'];

export function isLeafColumn(value: unknown): value is LeafColumn {
  return typeof value === 'string' && (LEAF_COLUMNS as readonly string[]).includes(value);
}

/**
 * Execution state, distinct from `column`. A leaf sits in a column because someone (or a persona)
 * put it there; its status reflects what the workflow actually did. Conflating them means a failed
 * run silently looks like work in progress.
 */
export type LeafStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Leaf {
  id: string;
  ownerId: string;
  /**
   * The request this leaf belongs to — a single user ask that the agent decomposed.
   *
   * The scoping unit rather than a long-lived board, because that is what a leaf actually belongs
   * to: "add OAuth to my app" produces a tree of leaves that live and die together. A board is a
   * view over many requests, not the thing leaves hang off.
   */
  requestId: string;
  title: string;
  body?: string;
  column: LeafColumn;
  status: LeafStatus;

  /** Absent on a root leaf. */
  parentLeafId?: string;
  /** 0 for a root leaf. Capped — see MAX_DEPTH. */
  depth: number;
  /**
   * Whether the parent waits for this child.
   *
   * true  — "split this into three, then integrate": the parent's status derives from it.
   * false — "I found follow-up work": the child outlives the parent and never blocks it.
   */
  blocking: boolean;

  personaId?: string;
  /** The Temporal workflow backing this leaf, once started. */
  workflowId?: string;
  projectId?: string;
  branch?: string;
  /** Root leaves only — the budget governing this leaf AND its whole subtree. */
  budget?: LeafBudget;

  /**
   * Every failed attempt at this leaf, oldest first.
   *
   * Kept rather than overwritten because the point of a retry is that the next attempt SEES why
   * the last one failed — see failureContext. A leaf that failed three different ways is a
   * different situation from one that failed the same way three times, and only the history
   * distinguishes them.
   */
  attempts?: LeafAttempt[];

  /**
   * Resources this leaf itself has consumed. Aggregated up to the root for budget checks —
   * see aggregateUsage. Absent means nothing recorded, never zero-and-final.
   */
  usage?: Partial<Omit<BudgetUsage, 'wallClockMs'>>;

  createdAt: string;
  updatedAt: string;
}

/**
 * Cost ceiling for a root leaf and everything beneath it.
 *
 * Deliberately on the ROOT rather than per leaf. Depth and fan-out caps alone still permit
 * 3 × 10 × 10 = 300 workspaces; only a subtree-wide budget actually bounds spend. It is also the
 * concrete mitigation for an injected "create 10,000 subtasks" — the prompt-injection risk in the
 * plan is not hypothetical once an agent reads a repo it did not write.
 */
export interface LeafBudget {
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

/** A single failed run of a leaf. */
export interface LeafAttempt {
  /** 0-based. Attempt 0 is the first try, so `attempt: 2` means two prior failures. */
  attempt: number;
  error: string;
  failedAt: string;
}

/**
 * How many times a leaf is retried before it is failed for good.
 *
 * Deliberately small. Retrying an agent task is only useful because the next attempt is given the
 * previous failure; if three attempts with accumulating context cannot make progress, a fourth is
 * unlikely to, and each one costs real tokens and wall-clock against the root's budget.
 */
export const MAX_LEAF_ATTEMPTS = 3;

/**
 * Formats prior failures for injection into the next attempt's context.
 *
 * This is the whole reason retries are not Temporal's built-in retry policy: that replays the
 * SAME input, so an agent task would fail identically every time. Progress requires the next
 * attempt to know what went wrong.
 *
 * Returns an empty string for a first attempt so callers can append unconditionally.
 */
export function failureContext(attempts: LeafAttempt[] | undefined): string {
  if (!attempts?.length) return '';
  const lines = attempts.map((a) => `Attempt ${a.attempt + 1} failed: ${a.error}`);
  return [
    `This work has been attempted ${attempts.length} time(s) before and failed:`,
    ...lines,
    'Do not repeat the same approach. Address the failure above.',
  ].join('\n');
}

/** Whether another attempt is permitted. */
export function shouldRetry(failuresSoFar: number, max = MAX_LEAF_ATTEMPTS): boolean {
  return failuresSoFar < max;
}

/** Three levels is enough to express "epic → task → subtask" and stops runaway decomposition. */
export const MAX_DEPTH = 3;
/** Per-leaf fan-out. Combined with MAX_DEPTH this bounds the subtree; the budget bounds the cost. */
export const MAX_CHILDREN_PER_LEAF = 10;

/**
 * Why a child may not be added, or undefined if it may.
 *
 * Returns a reason rather than a boolean so the refusal can be shown to the user (and fed back to
 * the agent that asked), instead of a silent no-op that looks like the request was lost.
 */
export function canAddChild(parent: Pick<Leaf, 'depth'>, existingChildren: number): string | undefined {
  if (parent.depth + 1 > MAX_DEPTH) {
    return `Maximum nesting depth of ${MAX_DEPTH} reached — break the work down differently rather than deeper`;
  }
  if (existingChildren >= MAX_CHILDREN_PER_LEAF) {
    return `A leaf may have at most ${MAX_CHILDREN_PER_LEAF} sub-items`;
  }
  return undefined;
}

/** Why the budget is spent, or undefined if there is room. */
export function budgetExceeded(budget: LeafBudget | undefined, usage: BudgetUsage): string | undefined {
  if (!budget) return undefined;
  if (budget.maxTokens !== undefined && usage.tokens >= budget.maxTokens) {
    return `Token budget exhausted (${usage.tokens}/${budget.maxTokens})`;
  }
  if (budget.maxWallClockMs !== undefined && usage.wallClockMs >= budget.maxWallClockMs) {
    // Rounded to whole minutes, a short budget reads as "0 minutes", which sounds like a bug
    // rather than a limit. Scale the unit to the magnitude instead.
    const ms = usage.wallClockMs;
    const elapsed = ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${(ms / 1000).toFixed(1)} seconds`;
    return `Time budget exhausted (${elapsed})`;
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
 * A leaf's effective status, derived from its blocking children when it has any.
 *
 * Only BLOCKING children count. A non-blocking child is follow-up work that outlives its parent,
 * so letting it drag the parent back to "running" would mean a leaf could never finish.
 *
 * The leaf's own failure always wins: if the work it was doing itself failed, children succeeding
 * does not redeem it.
 */
export function deriveLeafStatus(own: LeafStatus, children: Pick<Leaf, 'status' | 'blocking'>[]): LeafStatus {
  if (own === 'failed' || own === 'cancelled') return own;

  const blocking = children.filter((c) => c.blocking);
  if (blocking.length === 0) return own;

  if (blocking.some((c) => c.status === 'failed')) return 'failed';
  if (blocking.some((c) => c.status === 'pending' || c.status === 'running')) return 'running';
  // Every blocking child finished. The parent is only done when its OWN work is too — otherwise a
  // leaf whose children raced ahead would report success while it had not started integrating.
  if (blocking.every((c) => c.status === 'cancelled')) return own === 'succeeded' ? 'succeeded' : 'cancelled';
  return own === 'succeeded' ? 'succeeded' : 'running';
}

/**
 * Deterministic Temporal workflow id for a child leaf.
 *
 * MUST be deterministic, and this is the single easiest thing to get wrong here. Activities retry;
 * a partially-succeeded "create subtask" step with random ids produces duplicate leaves AND
 * duplicate workspace pods. Deriving the id from (parent, index) makes Temporal's own workflow-id
 * dedup do the work — a retry addresses the same child rather than spawning a second.
 *
 * Index-based rather than content-hashed on purpose. A hash collides whenever a planner legitimately
 * emits two identically-titled subtasks ("write tests"), which is common. Index is safe because the
 * caller must record the planner's proposed children as an ACTIVITY RESULT first: Temporal persists
 * and replays that list identically, so the ordering cannot drift between attempts even though the
 * model that produced it is non-deterministic.
 */
export function childWorkflowId(parentLeafId: string, index: number): string {
  return `leaf-${parentLeafId}-child-${index}`;
}

/** Leaves whose parent is `parentId`, in stable creation order. */
export function childrenOf(leaves: Leaf[], parentId: string): Leaf[] {
  return leaves
    .filter((c) => c.parentLeafId === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Walks up to the root leaf, which is where the budget lives.
 *
 * Returns undefined if the chain is broken (a parent id pointing at a leaf that no longer exists),
 * rather than looping — a cycle or dangling reference must not hang the caller.
 */
export function rootLeaf(leaves: Leaf[], leaf: Leaf): Leaf | undefined {
  const byId = new Map(leaves.map((c) => [c.id, c]));
  let current: Leaf | undefined = leaf;
  for (let i = 0; i <= MAX_DEPTH + 1 && current; i++) {
    if (!current.parentLeafId) return current;
    current = byId.get(current.parentLeafId);
  }
  return undefined;
}

/** Every descendant of a leaf, for aggregating usage against the root budget. */
export function subtreeOf(leaves: Leaf[], rootId: string): Leaf[] {
  const out: Leaf[] = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue; // guards against a cycle rather than spinning forever
    seen.add(id);
    for (const child of leaves.filter((c) => c.parentLeafId === id)) {
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/** Terminal states — a leaf here is no longer accruing wall-clock time. */
const FINISHED: readonly LeafStatus[] = ['succeeded', 'failed', 'cancelled'];

/**
 * Total resources consumed by a root leaf and its whole subtree.
 *
 * Wall-clock is measured from the ROOT's creation rather than summed across leaves, because
 * children run concurrently — summing their individual durations would count the same minutes
 * several times over and exhaust a time budget that had barely started.
 *
 * Tokens, workspaces and replans ARE summed, because those are genuinely consumed per leaf.
 *
 * `now` is injected rather than read from the clock so this stays pure and testable; a budget
 * check that silently depends on wall-clock time is miserable to write tests for.
 */
export function aggregateUsage(leaves: Leaf[], root: Leaf, now: number): BudgetUsage {
  const tree = [root, ...subtreeOf(leaves, root.id)];

  const sum = (field: keyof NonNullable<Leaf['usage']>): number =>
    tree.reduce((total, c) => total + (c.usage?.[field] ?? 0), 0);

  // A finished root stops the clock at its last update; a running one is still accruing.
  const start = Date.parse(root.createdAt);
  const end = FINISHED.includes(root.status) ? Date.parse(root.updatedAt) : now;
  const wallClockMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;

  return {
    tokens: sum('tokens'),
    workspaces: sum('workspaces'),
    replans: sum('replans'),
    wallClockMs,
  };
}
