import { stateFor, type Leaf, type LeafState } from './leaf-types.js';

const LIVE_STATUS = new Set(['proposed', 'pending', 'running']);

export function settledBranches(
  branches: { id: string }[],
  leaves: Leaf[],
): Set<string> {
  const settled = new Set<string>();
  for (const b of branches) {
    const mine = leaves.filter((l) => l.branchId === b.id);
    if (mine.length > 0 && !mine.some((l) => LIVE_STATUS.has(l.status))) settled.add(b.id);
  }
  return settled;
}

/** A short "failed after N attempts" summary, with no error text — safe to put on its own line. */
export function failureSummary(leaf: Leaf): string {
  const attempts = Array.isArray(leaf.attempts) ? leaf.attempts : [];
  return attempts.length
    ? `failed after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`
    : 'failed';
}

/** The most recent attempt's error, flattened to one line and capped — or undefined if there is none. */
export function lastFailureError(leaf: Leaf): string | undefined {
  const attempts = Array.isArray(leaf.attempts) ? leaf.attempts : [];
  const last = attempts[attempts.length - 1]?.error;
  if (!last) return undefined;
  const flat = last.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

export function outstandingWork(
  branches: { id: string; title: string }[],
  leaves: Leaf[],
): { leaf: Leaf; from: string; attempts: number; summary: string; lastError: string | undefined }[] {
  const settled = settledBranches(branches, leaves);
  return leaves
    .filter((l) => l.status === 'failed' && settled.has(l.branchId))
    .map((leaf) => ({
      leaf,
      from: branches.find((b) => b.id === leaf.branchId)?.title ?? '',
      attempts: Array.isArray(leaf.attempts) ? leaf.attempts.length : 0,
      summary: failureSummary(leaf),
      lastError: lastFailureError(leaf),
    }))
    .sort((a, b) => b.attempts - a.attempts);
}

export interface Attention {
  leaf: Leaf;
  reason: 'proposed' | 'failed';
}

export function needsYou(leaves: Leaf[], settled: Set<string> = new Set()): Attention[] {
  const count = (l: Leaf) => (Array.isArray(l.attempts) ? l.attempts.length : 0);
  const failed = leaves.filter((l) => l.status === 'failed' && !settled.has(l.branchId))
    .sort((a, b) => count(b) - count(a))
    .map((leaf): Attention => ({ leaf, reason: 'failed' }));
  const proposed = leaves.filter((l) => l.status === 'proposed')
    .map((leaf): Attention => ({ leaf, reason: 'proposed' }));
  return [...failed, ...proposed];
}

export function running(leaves: Leaf[]): Leaf[] {
  return leaves.filter((l) => l.status === 'running');
}

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
  outstanding: number;
  total: number;
  lastActivity: string;
}

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
      outstanding: states.length - verified - claimed,
      total: states.length,
      lastActivity: mine.reduce((newest, l) => (l.updatedAt > newest ? l.updatedAt : newest), ''),
    };
  }).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function scopeToTree<B extends { id: string; treeId?: string }>(
  treeId: string,
  branches: B[],
  leaves: Leaf[],
): { branches: B[]; leaves: Leaf[] } {
  const mine = branches.filter((b) => b.treeId === treeId);
  const ids = new Set(mine.map((b) => b.id));
  return { branches: mine, leaves: leaves.filter((l) => ids.has(l.branchId)) };
}

export function groupWork(leaves: Leaf[]): { state: LeafState; leaves: Leaf[] }[] {
  const order: LeafState[] = ['failed', 'blocked', 'running', 'proposed', 'claimed', 'verified'];
  return order
    .map((state) => ({ state, leaves: leaves.filter((l) => stateFor(l, leaves) === state) }))
    .filter((g) => g.leaves.length > 0);
}
