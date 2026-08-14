/**
 * A tree's work, counted the way the board shows it.
 *
 * ── WHY THE SERVER COUNTS ──
 * The frontend already has the leaves, so it could tally them. It should not: what counts as done
 * is a judgement this codebase has been careful about — `verified` means a check ran, `succeeded`
 * means the agent said so — and a rollup computed in a component is where that distinction gets
 * quietly flattened into one green number.
 *
 * ── WHY VERIFIED AND CLAIMED ARE NEVER ADDED TOGETHER ──
 * A board's "Done" column is normally the sum of everything that finished. Here half of that is a
 * model's own report on itself. Keeping them apart is the whole point of `leaf-verify.ts`, and a
 * progress bar that adds them would undo it at the last step — the one place a person actually
 * looks.
 */
import type { Leaf, LeafStatus } from './leaves.js';

/** Where a leaf sits on the board. Not the same as its status — see `columnFor`. */
export type BoardColumn = 'proposed' | 'blocked' | 'running' | 'claimed' | 'verified' | 'failed';

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  'proposed', 'blocked', 'running', 'claimed', 'verified', 'failed',
];

/**
 * Which column a leaf belongs in.
 *
 * `pending` splits in two, because "accepted and waiting its turn" and "accepted and nothing is
 * stopping it" look identical in the data and mean opposite things to someone reading the board:
 * one is queued, the other is stuck behind work that has not finished.
 *
 * `cancelled` is deliberately absent from the board. It is not work left to do and not work done —
 * counting it as either would misstate the total.
 */
export function columnFor(leaf: Leaf, blocked: boolean): BoardColumn | undefined {
  switch (leaf.status as LeafStatus) {
    case 'proposed': return 'proposed';
    case 'pending': return blocked ? 'blocked' : 'proposed';
    case 'running': return 'running';
    case 'failed': return 'failed';
    case 'cancelled': return undefined;
    case 'succeeded': return leaf.verified ? 'verified' : 'claimed';
    default: return undefined;
  }
}

export interface TreeRollup {
  counts: Record<BoardColumn, number>;
  /** Everything that is not finished, which is what "what is left" actually means. */
  outstanding: number;
  /** Measured tokens, not an estimate. The one number on this board that is not a judgement. */
  tokens: number;
  /** Leaves that took more than one attempt — the cheapest signal that something is wrong. */
  retried: number;
  /** How many distinct conversations produced this work. */
  branches: number;
}

export function rollup(leaves: Leaf[], isBlocked: (leaf: Leaf) => boolean): TreeRollup {
  const counts: Record<BoardColumn, number> = {
    proposed: 0, blocked: 0, running: 0, claimed: 0, verified: 0, failed: 0,
  };
  let tokens = 0;
  let retried = 0;
  const branches = new Set<string>();

  for (const leaf of leaves) {
    const column = columnFor(leaf, isBlocked(leaf));
    if (column) counts[column] += 1;
    tokens += leaf.usage?.tokens ?? 0;
    if ((leaf.attempts?.length ?? 0) > 1) retried += 1;
    branches.add(leaf.branchId);
  }

  return {
    counts,
    // Failed counts as outstanding: it is work the tree still owes, and hiding it in a "done"
    // total is how a project reports itself complete while broken.
    outstanding: counts.proposed + counts.blocked + counts.running + counts.failed,
    tokens,
    retried,
    branches: branches.size,
  };
}

/**
 * What changed since a given moment, so the board can say so.
 *
 * A Jira board changes when somebody drags a card. This one changes while nobody is watching —
 * leaves are proposed, started and finished by the system — so "3 changes since you last looked"
 * is not a nicety, it is the difference between a live board and a stale screenshot.
 */
export function changedSince(leaves: Leaf[], since: string | undefined): number {
  if (!since) return 0;
  return leaves.filter((l) => l.updatedAt > since).length;
}
