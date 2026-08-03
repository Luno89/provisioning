/**
 * Shared leaf vocabulary for the harness UI.
 *
 * Extracted so the tree and the detail pane cannot disagree about what a status is called or what
 * columns exist — two copies of a label table drift the moment one is edited.
 */

/** Work states only. No Backlog (a leaf exists because a branch needed it) and no Done
 *  (completion is `status`, and two sources of truth for it drift). */
export const COLUMNS = [
  { id: 'todo', label: 'To do' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
] as const;

export type ColumnId = (typeof COLUMNS)[number]['id'];

export type LeafStatus = 'proposed' | 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

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
  column: ColumnId;
  status: LeafStatus;
  parentLeafId?: string;
  depth: number;
  blocking: boolean;
  childCount: number;
  workflowId?: string;
  attempts?: LeafAttempt[];
  budget?: { maxTokens?: number; maxWallClockMs?: number; maxWorkspaces?: number };
  usageTotal?: { tokens: number; wallClockMs: number; workspaces: number; replans: number };
}

/**
 * Display labels only — the API keeps semantic values ('running', 'failed').
 *
 * Theming the wire format would make logs, errors and any future integration read as riddles. The
 * koala vocabulary belongs in the UI, where it is atmosphere, not in the contract. Every place
 * these are rendered also sets the raw status as a title attribute.
 */
export const STATUS_LABEL: Record<LeafStatus, string> = {
  proposed: 'Sprouting',
  pending: 'Ripe',
  running: 'Munching',
  succeeded: 'Digested',
  failed: 'Bitter',
  cancelled: 'Dropped',
};

export const STATUS_STYLE: Record<LeafStatus, string> = {
  proposed: 'text-emerald-400',
  pending: 'text-slate-500',
  running: 'text-blue-400',
  succeeded: 'text-green-400',
  failed: 'text-red-400',
  cancelled: 'text-slate-600 line-through',
};

/** A dot rather than a word, for the tree — where the shape of the work is what matters. */
export const STATUS_DOT: Record<LeafStatus, string> = {
  proposed: 'bg-emerald-500',
  pending: 'bg-slate-600',
  running: 'bg-blue-500',
  succeeded: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-slate-700',
};
