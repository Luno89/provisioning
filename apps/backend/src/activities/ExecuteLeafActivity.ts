/**
 * ExecuteLeafActivity — where a leaf's actual work happens.
 *
 * ── THE ARGUMENT IS JUST AN ID ──
 * This takes a leafId and nothing else. Everything it needs — the leaf, its body, its failure
 * history, and eventually retrieved memory — is read from MongoDB at execution time.
 *
 * That is what makes Temporal's own retry policy usable. The objection to native retries is that
 * they replay identical input, so an agent task fails identically every attempt. That is only true
 * when the context IS the input. Here the input is `{ leafId }` on every attempt while the context
 * is assembled fresh, and the previous attempt's failure was written to Mongo before it threw — so
 * attempt N+1 reads a database that attempt N changed. Same args, different prompt.
 *
 * It also keeps workflow history small. Temporal caps payload sizes, and threading a full prompt
 * (plus accumulated failures, plus retrieved documents) through workflow arguments would put all of
 * it in history, replayed on every activation.
 *
 * ── FAILURES ARE RECORDED BEFORE THROWING ──
 * Not after, and not by the caller. If the record were written by whoever catches the error, a
 * worker crash between the failure and the catch would lose the reason — and the retry would repeat
 * the same mistake with no idea it had made it before.
 */
import { Context } from '@temporalio/activity';
import { createDatabase } from '../lib/db-interface.js';
import { failureContext, type Leaf, type LeafAttempt } from '../lib/leaves.js';

export interface ExecuteLeafArgs {
  leafId: string;
}

export interface ExecuteLeafResult {
  leafId: string;
  /** Tokens consumed by this attempt, folded into the root's budget by the caller. */
  tokensUsed: number;
  summary: string;
}

/**
 * Assembles everything a persona needs to act on a leaf.
 *
 * Exported so the prompt-building can be tested without running an activity, and so Phase C adds
 * retrieval sources here rather than changing the workflow contract.
 */
export function buildLeafContext(leaf: Leaf, priorFailures: LeafAttempt[]): string {
  const parts = [`Task: ${leaf.title}`];
  if (leaf.body) parts.push(leaf.body);

  // The whole point of retrying. Without this the next attempt is identical to the one that just
  // failed, which is exactly what Temporal's built-in retry would give for free.
  const failures = failureContext(priorFailures);
  if (failures) parts.push(failures);

  return parts.join('\n\n');
}

export async function ExecuteLeafActivity(args: ExecuteLeafArgs): Promise<ExecuteLeafResult> {
  // Falls back to 1 outside an activity context, so the function stays callable from a test.
  const attemptNumber = Context.current?.()?.info?.attempt ?? 1;

  const db = createDatabase();
  await db.init();
  try {
    const leaf = (await db.getLeaves()).find((c: Leaf) => c.id === args.leafId);
    // A leaf deleted mid-flight is a normal race, not an error — failing would only produce a
    // retry storm against a row that is never coming back.
    if (!leaf) return { leafId: args.leafId, tokensUsed: 0, summary: 'Leaf no longer exists' };

    const priorFailures = leaf.attempts ?? [];
    const context = buildLeafContext(leaf, priorFailures);

    try {
      // Phase C replaces this with a persona: route to a model, run the agent CLI in a workspace,
      // commit, push. The surrounding shape — read context, record failure, report tokens — is what
      // is being established now, so that change is an implementation rather than a redesign.
      if (!leaf.personaId) {
        return {
          leafId: leaf.id,
          tokensUsed: 0,
          summary: `No persona assigned; nothing to execute. Context was ${context.length} characters.`,
        };
      }
      throw new Error(`Persona "${leaf.personaId}" is not implemented yet (Phase C)`);
    } catch (err: any) {
      // Written BEFORE rethrowing, so Temporal's retry re-reads a database this attempt changed.
      const attempts: LeafAttempt[] = [
        ...priorFailures,
        {
          // Read from the activity context, not passed in: an argument would be baked into
          // workflow history at the first call and stay 1 forever, mislabelling every retry.
          // Temporal counts attempts from 1; LeafAttempt counts from 0.
          attempt: Math.max(0, attemptNumber - 1),
          error: String(err?.message ?? err).slice(0, 2000),
          failedAt: new Date().toISOString(),
        },
      ];
      const latest = (await db.getLeaves()).find((c: Leaf) => c.id === args.leafId);
      if (latest) await db.saveLeaf({ ...latest, attempts, status: 'failed', updatedAt: new Date().toISOString() });
      throw err;
    }
  } finally {
    await db.close();
  }
}
