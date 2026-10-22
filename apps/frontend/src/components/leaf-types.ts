import type { DocumentAddress } from '../types/documents';

export type LeafStatus = 'pending' | 'running' | 'claimed' | 'succeeded' | 'failed' | 'cancelled';

export type LeafState = 'todo' | 'blocked' | 'running' | 'claimed' | 'verified' | 'failed';

export const BOARD_COLUMNS: { id: LeafState; label: string; hint: string }[] = [
  { id: 'todo', label: 'To do', hint: 'Waiting to start' },
  { id: 'blocked', label: 'Blocked', hint: 'Waiting on other work, or on its workspace being rebuilt' },
  { id: 'running', label: 'Running', hint: 'In a sandbox now' },
  { id: 'claimed', label: 'Claimed', hint: 'The agent says it worked. Nothing checked it.' },
  { id: 'verified', label: 'Verified', hint: 'A check ran and passed' },
  { id: 'failed', label: 'Failed', hint: 'Still owed' },
];

export function blockedBy<T extends { id: string; status: LeafStatus }>(
  leaf: { dependsOn?: string[] },
  all: T[],
): T[] {
  return (leaf.dependsOn ?? [])
    .map((id) => all.find((l) => l.id === id))
    .filter((d): d is T => d !== undefined && d.status !== 'succeeded');
}

export function stateFor(
  leaf: { status: LeafStatus; verified?: boolean; dependsOn?: string[]; waitingFor?: { reason: string; since: string; stuck?: string | undefined } | undefined },
  all: { id: string; status: LeafStatus }[],
): LeafState | undefined {
  switch (leaf.status) {
    case 'pending': return leaf.waitingFor || blockedBy(leaf, all).length > 0 ? 'blocked' : 'todo';
    case 'running': return 'running';
    case 'claimed': return 'claimed';
    case 'failed': return 'failed';
    case 'cancelled': return undefined;
    case 'succeeded': return leaf.verified ? 'verified' : 'claimed';
    default: return undefined;
  }
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `StoryDrop` in `apps/backend/src/files/lib/story-drops.ts`, which is the authority.
 */
export interface StoryDrop {
  id: string;
  branch: string;
  paths: string[];
  at: string;
  by: string;
  state: 'waiting' | 'merged' | 'conflict';
  conflicts?: string[];
  mergedAt?: string;
}

export interface LeafAttempt {
  attempt: number;
  error: string;
  failedAt: string;
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `Leaf` in `apps/backend/src/projects/lib/leaves.ts`, which is the authority.
 */
export interface Leaf {
  id: string;
  branchId: string;
  title: string;
  body?: string;
  status: LeafStatus;
  dependsOn?: string[];
  tasks?: string[];
  replans?: number;
  priority?: number;
  runId?: string;
  attempts?: LeafAttempt[];
  waitingFor?: { reason: string; since: string; stuck?: string | undefined };
  findings?: string;
  claim?: { evidence: string; commit?: string; files?: string[]; findings?: string; runs?: string[]; at: string };
  verified?: boolean;
  landed?: { at: string; outcome: 'merged' | 'nothing' };
  review?: { verdict: 'sound' | 'concern' | 'unsound'; reason?: string; model?: string; at: string };
  drops?: StoryDrop[];
  createdAt?: string;
  updatedAt: string;
}

export function isAwaitingReview(leaf: Pick<Leaf, 'status' | 'claim' | 'review'>): boolean {
  return leaf.status === 'claimed' && leaf.claim !== undefined && leaf.review !== undefined && leaf.review.at >= leaf.claim.at;
}

export const STATE_LABEL: Record<LeafState, string> =
  Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, c.label])) as Record<LeafState, string>;

export const STATE_HINT: Record<LeafState, string> =
  Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, c.hint])) as Record<LeafState, string>;

export const STATE_STYLE: Record<LeafState, string> = {
  todo: 'text-emerald-400',
  blocked: 'text-slate-500',
  running: 'text-blue-400',
  claimed: 'text-amber-400',
  verified: 'text-green-400',
  failed: 'text-red-400',
};

export const STATE_DOT: Record<LeafState, string> = {
  todo: 'bg-emerald-500',
  blocked: 'bg-slate-600',
  running: 'bg-blue-500 animate-pulse',
  claimed: 'bg-amber-500',
  verified: 'bg-green-500',
  failed: 'bg-red-500',
};

export const CANCELLED_DOT = 'bg-slate-700';

/**
 * ── DUPLICATED, KNOWINGLY ──
 * The tree's workspace name mirrors `treeWorkspaceRunId` in
 * `apps/backend/src/engine-host/sandboxes/workspace-repos.ts`, which wins.
 */
export const treeWorkspace = (treeId: string): string => `tree-${treeId}`;

export function leafDocuments(leaf: Pick<Leaf, 'claim'>, treeId: string): DocumentAddress[] {
  const commit = leaf.claim?.commit;
  if (!commit) return [];
  return (leaf.claim?.files ?? []).map((path) => ({ workspace: treeWorkspace(treeId), path, at: commit }));
}

export interface StoryLine {
  text: string;
  reopened: boolean;
}

const onDay = (at: string): string => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function storyLine(
  leaf: Pick<Leaf, 'status' | 'verified' | 'landed' | 'attempts' | 'waitingFor' | 'dependsOn' | 'review' | 'claim' | 'updatedAt'>,
  all: { id: string; title: string; status: LeafStatus }[],
  tasks: { done: number; total: number } = { done: 0, total: 0 },
): StoryLine {
  const reopened = Boolean(leaf.landed) && leaf.status !== 'succeeded' && leaf.status !== 'cancelled';
  const left = tasks.total - tasks.done;
  const toDo = tasks.total > 0 ? `${left} of ${tasks.total} ${tasks.total === 1 ? 'task' : 'tasks'} to do` : '';
  const tried = (leaf.attempts ?? []).length;
  switch (leaf.status) {
    case 'cancelled':
      return { text: 'Cancelled', reopened };
    case 'succeeded': {
      const who = leaf.review?.model === 'person' ? 'verified by you' : 'verified';
      if (leaf.landed?.outcome === 'merged') return { text: `Done: ${who} and landed on main ${onDay(leaf.landed.at)}`, reopened };
      if (leaf.landed) return { text: `Done: ${who}; main already had its work`, reopened };
      return leaf.verified
        ? { text: `Done: ${who}; it lands on main when this judge pass ends`, reopened }
        : { text: 'Claimed done: waiting for the judge', reopened };
    }
    case 'claimed':
      return isAwaitingReview(leaf)
        ? { text: 'Waiting for your review: the judge could not settle it', reopened }
        : { text: 'Claimed done: waiting for the judge', reopened };
    case 'running':
      return { text: `Being worked now${reopened ? ` (reopened ${onDay(leaf.updatedAt)})` : ''}${toDo ? `: ${toDo}` : ''}`, reopened };
    case 'failed':
      return { text: `Failed after ${tried || 1} ${tried === 1 || tried === 0 ? 'attempt' : 'attempts'}`, reopened };
    case 'pending': {
      if (leaf.waitingFor) return { text: `Put aside until its workspace is rebuilt: ${leaf.waitingFor.reason}`, reopened };
      const waits = blockedBy(leaf, all);
      if (waits.length > 0) return { text: `Waits on ${waits.map((other) => `“${other.title}”`).join(', ')}`, reopened };
      if (reopened) return { text: `Reopened ${onDay(leaf.updatedAt)}${toDo ? `: ${toDo}` : ''}`, reopened };
      return { text: `To do${toDo ? `: ${toDo}` : ''}`, reopened };
    }
  }
}
