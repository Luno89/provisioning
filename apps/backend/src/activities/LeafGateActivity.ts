import { dependenciesMet, blockedBy, dependentsOf, shouldRetry, type Leaf } from '../lib/leaves.js';
import { createDatabase } from '../lib/db-interface.js';
import { getTemporalClient } from '../lib/temporal-client.js';

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
  const db = createDatabase();
  await db.init();
  try {
    const leaves = await db.getLeaves();
    const waiting = dependentsOf(args.leafId, leaves)
      .filter((l) => l.status === 'pending' || l.status === 'running');
    if (waiting.length === 0) return { released: [] };

    const client = await getTemporalClient();
    const released: string[] = [];

    for (const leaf of waiting) {
      try {
        await client.workflow.signalWithStart('LeafWorkflow', {
          workflowId: `leaf-${leaf.id}`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'host-ops-queue',
          args: [{ leafId: leaf.id, title: leaf.title, column: leaf.column, depth: leaf.depth }],
          signal: 'dependencyCompleted',
          signalArgs: [args.leafId],
        });
        released.push(leaf.id);
      } catch (err) {
        console.warn(`[ReleaseDependents] could not wake leaf ${leaf.id}: ${(err as Error).message}`);
      }
    }
    return { released };
  } finally {
    await db.close();
  }
}
