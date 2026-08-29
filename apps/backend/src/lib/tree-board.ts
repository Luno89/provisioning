import type { Leaf, LeafStatus } from './leaves.js';

export type BoardColumn = 'proposed' | 'blocked' | 'running' | 'claimed' | 'verified' | 'failed';

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  'proposed', 'blocked', 'running', 'claimed', 'verified', 'failed',
];

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
  outstanding: number;
  tokens: number;
  retried: number;
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
    outstanding: counts.proposed + counts.blocked + counts.running + counts.failed,
    tokens,
    retried,
    branches: branches.size,
  };
}

export function changedSince(leaves: Leaf[], since: string | undefined): number {
  if (!since) return 0;
  return leaves.filter((l) => l.updatedAt > since).length;
}
