/**
 * The dependency gate, and the release that opens it.
 *
 * ── WHY THESE ARE ACTIVITIES ──
 * Both could have been written as workflow code reading a cached DAG. They are activities on
 * purpose, for two separate reasons:
 *
 *   · Workflow code is replay-bound. Readiness rules WILL change — that is the nature of a planner
 *     that is still being tuned — and every change to logic living in workflow code means reaching
 *     for `patched()` and carrying both branches for as long as anything in flight remembers the
 *     old one. In an activity it is an ordinary function call against current code.
 *   · The dependency EDGES stay on the board rather than in workflow state. They are intent, not
 *     execution, and they change from outside while a plan runs — a leaf is accepted, a proposal is
 *     edited, work is cancelled. Re-reading them at each decision point costs one activity call and
 *     makes all of that take effect for free. Caching them in workflow state would buy nothing and
 *     cost a signal protocol for every mutation.
 *
 * Temporal owns WHEN things run; the board owns WHAT depends on what. There is no second source of
 * truth because only one of them decides execution.
 */
import { dependenciesMet, blockedBy, dependentsOf, shouldRetry, type Leaf } from '../lib/leaves.js';
import { createDatabase } from '../lib/db-interface.js';
import { getTemporalClient } from '../lib/temporal-client.js';

export interface LeafGateArgs {
  leafId: string;
}

/**
 * A failure with no attempts left — never going to succeed, so anything waiting on it is stuck.
 *
 * Distinct from an ordinary `failed`, which is genuinely temporary: Temporal retries the activity,
 * and each attempt reads a database (and now a repository) the previous one changed, so the work is
 * still expected. Only once the attempts are spent does the leaf become a dead end.
 *
 * Observed: "Implement JSON config parser module" failed all three attempts, and the leaf that
 * depended on it sat `pending` with no workflow and no prospect of ever getting one — indefinitely,
 * and looking exactly like work that had not started yet.
 */
function isTerminallyFailed(leaf: Leaf): boolean {
  return leaf.status === 'failed' && !shouldRetry((leaf.attempts ?? []).length);
}

/**
 * What the workflow should do, rather than a set of booleans it has to interpret.
 *
 * `stop` and `abandon` are deliberately different. `stop` means this workflow should never have
 * been running and must leave the leaf exactly as it found it; `abandon` means the leaf is real but
 * can never start, and someone has to be told.
 */
export type LeafGateDecision = 'proceed' | 'wait' | 'abandon' | 'stop';

export interface LeafGateResult {
  decision: LeafGateDecision;
  /** Titles of the leaves still holding this one up, for the log and the board. */
  waitingFor: string[];
  /** Set on `abandon` — which dependency made this unreachable. */
  reason?: string;
}

export async function CheckLeafGateActivity(args: LeafGateArgs): Promise<LeafGateResult> {
  const db = createDatabase();
  await db.init();
  try {
    const leaves = await db.getLeaves();
    const leaf = leaves.find((l: Leaf) => l.id === args.leafId);
    // A deleted leaf is a normal race, not an error — same reasoning as UpdateLeafActivity.
    if (!leaf) return { decision: 'stop', waitingFor: [] };

    /**
     * `signalWithStart` will START a workflow whose id names a CLOSED execution, so a completing
     * leaf signalling a dependent that was cancelled — or has already run — would quietly
     * resurrect it. This is the guard, and it is why the gate runs before anything else.
     *
     * 'proposed' belongs here too: a proposal has not been accepted, and a dependency finishing is
     * not acceptance. Starting it would spend budget nobody agreed to.
     */
    if (leaf.status === 'cancelled' || leaf.status === 'succeeded' || leaf.status === 'proposed') {
      return { decision: 'stop', waitingFor: [] };
    }

    const blockers = blockedBy(leaf, leaves);

    /**
     * A dependency that can never succeed makes this leaf unreachable.
     *
     * Without this the leaf parks on the gate forever — an open workflow waiting for a signal that
     * is never coming, invisible except as a card that never moves. A DELETED dependency is
     * deliberately not in this category: `dependenciesMet` already treats a dangling id as met, on
     * the grounds that the ordering was lost when the leaf was removed and stranding the dependent
     * is the worse failure.
     */
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

/**
 * Wakes everything waiting on this leaf.
 *
 * `signalWithStart`, not `start`, because of a race with no other clean answer: the dependent may
 * not have a workflow yet (nothing has started it — that is the whole point of the gate), or it may
 * already be running and parked on the gate. Signalling a workflow that does not exist loses the
 * event; starting one that already exists is an error. `signalWithStart` is the single primitive
 * that does the right thing either way.
 *
 * Idempotent by construction. Workflow ids are `leaf-<id>`, so two dependencies finishing at the
 * same moment address the same execution — one starts it, the other signals it, and the gate
 * re-reads the board rather than counting arrivals.
 *
 * Called on FAILURE as well as success. A dependent whose dependency failed will never satisfy
 * `dependenciesMet` and must not start — but it still needs to be woken to find that out, or a
 * diamond with one failed arm strands the other arm's dependents on a signal that never comes.
 */
export async function ReleaseDependentsActivity(args: LeafGateArgs): Promise<ReleaseDependentsResult> {
  const db = createDatabase();
  await db.init();
  try {
    const leaves = await db.getLeaves();
    const waiting = dependentsOf(args.leafId, leaves)
      // A dependent that already finished, was cancelled, or is only proposed has nothing to wake.
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
        // One unreachable dependent must not stop the others being woken. The reconcile backstop
        // catches whatever is missed here, which is exactly what it is still there for.
        console.warn(`[ReleaseDependents] could not wake leaf ${leaf.id}: ${(err as Error).message}`);
      }
    }
    return { released };
  } finally {
    await db.close();
  }
}
