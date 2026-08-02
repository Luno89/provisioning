/**
 * UpdateLeafActivity
 *
 * Writes a leaf's execution state back to the database so the board can render it.
 *
 * The split is deliberate: the WORKFLOW is authoritative for what is actually happening (it
 * survives restarts, holds the child fan-out, and is what a signal addresses), while the database
 * row is the readable projection the UI queries. Without this activity the two drift — a workflow
 * would complete and the board would still show the leaf running, which is exactly the class of
 * bug the Temporal reconciliation loop exists to paper over for clusters.
 *
 * Writes only the fields it is given, because a leaf carries user-authored content (title, body)
 * that a workflow must never clobber — the same full-replace hazard that bites saveClusterInfo.
 */
import { createDatabase } from '../lib/db-interface.js';
import type { Leaf, LeafAttempt, LeafColumn, LeafStatus } from '../lib/leaves.js';

export interface UpdateLeafArgs {
  leafId: string;
  status?: LeafStatus;
  column?: LeafColumn;
  workflowId?: string;
  /**
   * Full attempt history, replacing whatever is stored.
   *
   * Replaced rather than appended because the WORKFLOW owns this list — it accumulates failures
   * across retries and passes the same array into the next attempt's context. Appending here too
   * would double-count on an activity retry, which is precisely the kind of duplication the
   * deterministic child ids elsewhere exist to prevent.
   */
  attempts?: LeafAttempt[];
  /**
   * Consumption to ADD to whatever is stored, not replace.
   *
   * Opposite of `attempts` on purpose: the workflow owns the failure list and replaces it wholesale,
   * whereas tokens accrue across separate calls and each report is new spend. Replacing here would
   * silently discard everything but the last attempt's usage.
   */
  usage?: { tokens?: number; workspaces?: number; replans?: number };
}

export async function UpdateLeafActivity(args: UpdateLeafArgs): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    const leaves = await db.getLeaves();
    const leaf = leaves.find((c: Leaf) => c.id === args.leafId);
    // A leaf deleted while its workflow was still running is a normal race, not an error: the
    // delete already removed the subtree, and failing here would only produce a retry storm
    // against a row that is never coming back.
    if (!leaf) return;

    await db.saveLeaf({
      ...leaf,
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.column !== undefined ? { column: args.column } : {}),
      ...(args.workflowId !== undefined ? { workflowId: args.workflowId } : {}),
      ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
      ...(args.usage
        ? {
            usage: {
              tokens: (leaf.usage?.tokens ?? 0) + (args.usage.tokens ?? 0),
              workspaces: (leaf.usage?.workspaces ?? 0) + (args.usage.workspaces ?? 0),
              replans: (leaf.usage?.replans ?? 0) + (args.usage.replans ?? 0),
            },
          }
        : {}),
      updatedAt: new Date().toISOString(),
    });
  } finally {
    await db.close();
  }
}
