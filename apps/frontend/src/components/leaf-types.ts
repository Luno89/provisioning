/**
 * Shared leaf vocabulary for the harness UI.
 *
 * Extracted so the tree and the detail pane cannot disagree about what a status is called or what
 * columns exist — two copies of a label table drift the moment one is edited.
 */

export type LeafStatus = 'proposed' | 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * The one vocabulary for a leaf's state.
 *
 * ── WHY THIS REPLACED THREE OTHERS ──
 * A leaf used to be described four different ways at once. Observed on a single screen, for a
 * single leaf: the detail pane said **Digested**, a control beside it said **Review**, and the board
 * filed it under **Verified** — while the API called it `succeeded`. Four names, one fact.
 *
 * The sets were:
 *   - `proposed|pending|running|succeeded|failed|cancelled`  — the API, and the only real one
 *   - `Sprouting|Ripe|Munching|Digested|Bitter|Dropped`      — a themed table, deleted
 *   - `To do|In progress|Review`                             — a vestigial board, deleted
 *   - `To do|Blocked|Running|Claimed|Verified|Failed`        — the tree board, kept
 *
 * The themed one went because it cost a lookup on every glance and paid nothing back: `Bitter` does
 * not read as "this failed" and `Ripe` does not read as "queued". The koala stays everywhere it is
 * atmosphere; it does not get to name states you have to act on.
 *
 * The board's set is kept because it is the only one that distinguishes the thing that matters —
 * `claimed` (an agent said so) from `verified` (a check ran). See lib/leaf-verify.ts.
 */
export type LeafState = 'proposed' | 'blocked' | 'running' | 'claimed' | 'verified' | 'failed';

export const BOARD_COLUMNS: { id: LeafState; label: string; hint: string }[] = [
  { id: 'proposed', label: 'To do', hint: 'Waiting to start' },
  { id: 'blocked', label: 'Blocked', hint: 'Waiting on other work' },
  { id: 'running', label: 'Running', hint: 'In a sandbox now' },
  { id: 'claimed', label: 'Claimed', hint: 'The agent says it worked. Nothing checked it.' },
  { id: 'verified', label: 'Verified', hint: 'A check ran and passed' },
  { id: 'failed', label: 'Failed', hint: 'Still owed' },
];

/**
 * Dependencies that have not succeeded yet.
 *
 * Mirrors `blockedBy` in apps/backend/src/lib/leaves.ts. The frontend cannot import backend modules,
 * so this is the one copy on this side — and it is a mirror rather than a second opinion: any change
 * to the rule belongs in both, and the pair is asserted in leaf-state.test.ts.
 */
export function blockedBy<T extends { id: string; status: LeafStatus }>(
  leaf: { dependsOn?: string[] },
  all: T[],
): T[] {
  return (leaf.dependsOn ?? [])
    .map((id) => all.find((l) => l.id === id))
    .filter((d): d is T => d !== undefined && d.status !== 'succeeded');
}

/**
 * Which column a leaf belongs in — the single place the UI decides what state means.
 *
 * Mirrors `columnFor` in apps/backend/src/lib/tree-board.ts, including its one subtlety: a
 * `cancelled` leaf returns nothing, because it is neither done nor outstanding and putting it in a
 * column would make it count towards one of them.
 */
export function stateFor(
  leaf: { status: LeafStatus; verified?: boolean; dependsOn?: string[] },
  all: { id: string; status: LeafStatus }[],
): LeafState | undefined {
  switch (leaf.status) {
    case 'proposed': return 'proposed';
    case 'pending': return blockedBy(leaf, all).length > 0 ? 'blocked' : 'proposed';
    case 'running': return 'running';
    case 'failed': return 'failed';
    case 'cancelled': return undefined;
    case 'succeeded': return leaf.verified ? 'verified' : 'claimed';
    default: return undefined;
  }
}

export interface LeafAttempt {
  attempt: number;
  error: string;
  failedAt: string;
}

export interface Leaf {
  id: string;
  branchId: string;
  title: string;
  body?: string;
  /**
   * NOT the leaf's state — deliberately absent.
   *
   * The record carries a `column` field that still defaults to 'todo', and the board endpoint
   * OVERWRITES the same property name with a board column, so `column` means 'todo' from
   * /api/leaves and 'verified' from /api/trees/:id/board. Reading it was how the UI ended up
   * showing two answers for one leaf. State is derived — see `stateFor`.
   */
  status: LeafStatus;
  parentLeafId?: string;
  depth: number;
  blocking: boolean;
  childCount: number;
  workflowId?: string;
  attempts?: LeafAttempt[];
  /** Last write, ISO 8601. Used to order branches reconstructed from their leaves. */
  updatedAt: string;

  /**
   * ── WHAT ACTUALLY CHECKED THIS, AND WHERE THE WORK WENT ──
   *
   * The backend has recorded all of this for a while and none of it reached the screen: a leaf
   * showed a status dot and nothing about whether anything verified it, or which branch to look at.
   * A green tick that means "an agent said so" and one that means "its tests ran and passed" are
   * very different claims, and the board rendered them identically.
   */
  verified?: boolean;
  merged?: boolean;
  /** The branch this leaf pushed to — the only pointer from a card to the actual work. */
  outputBranch?: string;
  projectId?: string;
  /** Files it promised to leave behind, checked after it ran. */
  expects?: string[];
  /** Ids of the leaves it waits on — the ordering you are agreeing to when you accept. */
  dependsOn?: string[];
  /**
   * Who will do the work.
   *
   * A persona carries the whole environment it runs in, so a leaf without one cannot run at all —
   * which is why the board shows it rather than letting acceptance fail later.
   */
  personaId?: string;
  /** What the agent reported doing. Its claim, not a result. */
  summary?: string;
  /** A research leaf's answer, stored on the record because it has no repository. */
  findings?: string;
  budget?: { maxTokens?: number; maxWallClockMs?: number; maxWorkspaces?: number };
  usageTotal?: { tokens: number; wallClockMs: number; workspaces: number; replans: number };
}

export const STATE_LABEL: Record<LeafState, string> =
  Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, c.label])) as Record<LeafState, string>;

/** The hint each column carries, reused as a tooltip wherever a state is named. */
export const STATE_HINT: Record<LeafState, string> =
  Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, c.hint])) as Record<LeafState, string>;

/**
 * Amber for `claimed`, green for `verified`, and never the same colour.
 *
 * The distinction is the point of the whole vocabulary, so it survives into the palette: a claim
 * that reads green at a glance is a claim that has been laundered into a fact.
 */
export const STATE_STYLE: Record<LeafState, string> = {
  proposed: 'text-emerald-400',
  blocked: 'text-slate-500',
  running: 'text-blue-400',
  claimed: 'text-amber-400',
  verified: 'text-green-400',
  failed: 'text-red-400',
};

/** A dot rather than a word, for the navigator — where the shape of the work is what matters. */
export const STATE_DOT: Record<LeafState, string> = {
  proposed: 'bg-emerald-500',
  blocked: 'bg-slate-600',
  running: 'bg-blue-500 animate-pulse',
  claimed: 'bg-amber-500',
  verified: 'bg-green-500',
  failed: 'bg-red-500',
};

/** A cancelled leaf is off-board, so it needs a dot the columns never supply. */
export const CANCELLED_DOT = 'bg-slate-700';
