import { dependenciesMet, blockedBy, shouldRetry, type Leaf } from '../lib/leaves.js';
import { createDatabase } from '../lib/db-interface.js';

export interface LeafGateArgs {
  leafId: string;
}

function isTerminallyFailed(leaf: Leaf): boolean {
  return leaf.status === 'failed' && !shouldRetry((leaf.attempts ?? []).length);
}

export type LeafGateDecision = 'proceed' | 'wait' | 'abandon' | 'stop';

export interface LeafGateResult {
  decision: LeafGateDecision;
  waitingFor: string[];
  reason?: string;
}

export async function CheckLeafGateActivity(args: LeafGateArgs): Promise<LeafGateResult> {
  const db = createDatabase();
  await db.init();
  try {
    const leaves = await db.getLeaves();
    const leaf = leaves.find((l: Leaf) => l.id === args.leafId);
    if (!leaf) return { decision: 'stop', waitingFor: [] };

    if (leaf.status === 'cancelled' || leaf.status === 'succeeded' || leaf.status === 'proposed') {
      return { decision: 'stop', waitingFor: [] };
    }

    const blockers = blockedBy(leaf, leaves);

    const dead = blockers.find((b) => b.status === 'cancelled' || isTerminallyFailed(b));
    if (dead) {
      return {
        decision: 'abandon',
        waitingFor: blockers.map((l) => l.title),
        reason: dead.status === 'cancelled'
          ? `"${dead.title}" was cancelled, so this work can never start`
          : `"${dead.title}" failed every attempt, so this work can never start`,
      };
    }

    return {
      decision: dependenciesMet(leaf, leaves) ? 'proceed' : 'wait',
      waitingFor: blockers.map((l) => l.title),
    };
  } finally {
    await db.close();
  }
}

export interface ReleaseDependentsResult {
  released: string[];
}

export async function ReleaseDependentsActivity(args: LeafGateArgs): Promise<ReleaseDependentsResult> {
  console.warn(`[ReleaseDependents] ${args.leafId} finished, but the old leaf pipeline no longer starts leaves, so nothing waiting on it is woken`);
  return { released: [] };
}
