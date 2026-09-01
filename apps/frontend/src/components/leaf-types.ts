
export type LeafStatus = 'proposed' | 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type LeafState = 'proposed' | 'blocked' | 'running' | 'claimed' | 'verified' | 'failed';

export const BOARD_COLUMNS: { id: LeafState; label: string; hint: string }[] = [
  { id: 'proposed', label: 'To do', hint: 'Waiting to start' },
  { id: 'blocked', label: 'Blocked', hint: 'Waiting on other work' },
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
  status: LeafStatus;
  parentLeafId?: string;
  depth: number;
  blocking: boolean;
  childCount: number;
  workflowId?: string;
  attempts?: LeafAttempt[];
  updatedAt: string;

  verified?: boolean;
  merged?: boolean;
  outputBranch?: string;
  projectId?: string;
  expects?: string[];
  dependsOn?: string[];
  personaId?: string;
  /** Which pack carries this leaf out. `personaId` predates it and is no longer written. */
  packId?: string;
  summary?: string;
  findings?: string;
  budget?: { maxTokens?: number; maxWallClockMs?: number; maxWorkspaces?: number; maxReplans?: number };
  usage?: { tokens?: number; workspaces?: number; replans?: number };
  usageTotal?: { tokens?: number; wallClockMs?: number; workspaces?: number; replans?: number };
}

export const STATE_LABEL: Record<LeafState, string> =
  Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, c.label])) as Record<LeafState, string>;

export const STATE_HINT: Record<LeafState, string> =
  Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, c.hint])) as Record<LeafState, string>;

export const STATE_STYLE: Record<LeafState, string> = {
  proposed: 'text-emerald-400',
  blocked: 'text-slate-500',
  running: 'text-blue-400',
  claimed: 'text-amber-400',
  verified: 'text-green-400',
  failed: 'text-red-400',
};

export const STATE_DOT: Record<LeafState, string> = {
  proposed: 'bg-emerald-500',
  blocked: 'bg-slate-600',
  running: 'bg-blue-500 animate-pulse',
  claimed: 'bg-amber-500',
  verified: 'bg-green-500',
  failed: 'bg-red-500',
};

export const CANCELLED_DOT = 'bg-slate-700';
