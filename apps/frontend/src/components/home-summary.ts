import { stateFor, type Leaf, type LeafState } from './leaf-types.js';

/**
 * What Koala has been doing, and what it needs from you.
 *
 * ── WHY A SUMMARY EXISTS AT ALL ──
 * The harness's landing page was a list of branches beside an empty pane reading "Select a branch
 * or leaf" — a navigator with no destination. That is the wrong shape for this product: Koala runs
 * work unattended, overnight, and the question you actually arrive with is "what happened while I
 * was away, and what is waiting on me". A file tree cannot answer either.
 *
 * Everything here is derived from records the platform already writes. Nothing new is stored.
 */

export interface Attention {
  leaf: Leaf;
  /** Why it is on the list, which decides what the button does. */
  reason: 'proposed' | 'failed';
}

/**
 * Work that cannot move without you.
 *
 * Failures first: a proposal is a decision you have not made yet, a failure is work already spent
 * that is owed. Within failures, the most-attempted first — a leaf on its third attempt is the one
 * least likely to fix itself.
 */
export function needsYou(leaves: Leaf[]): Attention[] {
  const count = (l: Leaf) => (Array.isArray(l.attempts) ? l.attempts.length : 0);
  const failed = leaves.filter((l) => l.status === 'failed')
    .sort((a, b) => count(b) - count(a))
    .map((leaf): Attention => ({ leaf, reason: 'failed' }));
  const proposed = leaves.filter((l) => l.status === 'proposed')
    .map((leaf): Attention => ({ leaf, reason: 'proposed' }));
  return [...failed, ...proposed];
}

/** In a sandbox right now. Its own list because it is the one thing that changes while you watch. */
export function running(leaves: Leaf[]): Leaf[] {
  return leaves.filter((l) => l.status === 'running');
}

/**
 * What moved since a timestamp.
 *
 * Excludes anything still running: those are already on their own list, and counting them twice
 * makes a quiet night look busy.
 */
export function changedSince(leaves: Leaf[], since: string | undefined): Leaf[] {
  if (!since) return [];
  return leaves
    .filter((l) => l.status !== 'running' && l.updatedAt > since)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface TreeRollup {
  id: string;
  name: string;
  verified: number;
  claimed: number;
  failed: number;
  /** Everything not finished — the honest "how much is left". */
  outstanding: number;
  total: number;
  /** Most recent leaf activity, for ordering. Empty when the tree has never run anything. */
  lastActivity: string;
}

/**
 * Per-tree progress, counted the same way the board counts it.
 *
 * `claimed` is kept apart from `verified` here as everywhere else: folding them into one "done"
 * figure on a summary page would be the most damaging place yet to do it, because a summary is
 * read fastest and questioned least.
 */
export function treeRollups(
  trees: { id: string; name: string }[],
  branches: { id: string; treeId?: string }[],
  leaves: Leaf[],
): TreeRollup[] {
  return trees.map((tree) => {
    const ids = new Set(branches.filter((b) => b.treeId === tree.id).map((b) => b.id));
    const mine = leaves.filter((l) => ids.has(l.branchId));
    const states = mine.map((l) => stateFor(l, leaves)).filter((s): s is LeafState => s !== undefined);
    const count = (s: LeafState) => states.filter((x) => x === s).length;
    const verified = count('verified');
    const claimed = count('claimed');
    const failed = count('failed');
    return {
      id: tree.id,
      name: tree.name,
      verified,
      claimed,
      failed,
      // Cancelled leaves are excluded by stateFor, so they cannot inflate what is left.
      outstanding: states.length - verified - claimed,
      total: states.length,
      lastActivity: mine.reduce((newest, l) => (l.updatedAt > newest ? l.updatedAt : newest), ''),
    };
  }).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

/** "3 minutes ago" — an absolute timestamp makes you do arithmetic to answer "is this stale". */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  // A clock skew between the server and the browser must not read as "in 4 seconds".
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Everything belonging to one tree.
 *
 * The same summary serves two altitudes — everything you own, and one project — so scoping happens
 * once here rather than being re-derived by each section. A branch with no tree matches nothing,
 * which is correct: unfiled conversations belong to no project.
 */
export function scopeToTree<B extends { id: string; treeId?: string }>(
  treeId: string,
  branches: B[],
  leaves: Leaf[],
): { branches: B[]; leaves: Leaf[] } {
  const mine = branches.filter((b) => b.treeId === treeId);
  const ids = new Set(mine.map((b) => b.id));
  return { branches: mine, leaves: leaves.filter((l) => ids.has(l.branchId)) };
}

/**
 * The work of a tree, grouped the way you would ask about it.
 *
 * A list rather than columns. Columns showed exactly one attribute — state — which every row
 * already carries, and spent the width of the pane doing it; on a finished tree five of the six
 * stood empty. Grouping keeps the one thing the columns were for and costs nothing.
 *
 * Owed first, then in flight, then the claims that nothing checked, then what is actually done.
 * That is descending order of "should you do something about this".
 */
export function groupWork(leaves: Leaf[]): { state: LeafState; leaves: Leaf[] }[] {
  const order: LeafState[] = ['failed', 'blocked', 'running', 'proposed', 'claimed', 'verified'];
  return order
    .map((state) => ({ state, leaves: leaves.filter((l) => stateFor(l, leaves) === state) }))
    .filter((g) => g.leaves.length > 0);
}
