/**
 * UpdateCardActivity
 *
 * Writes a card's execution state back to the database so the board can render it.
 *
 * The split is deliberate: the WORKFLOW is authoritative for what is actually happening (it
 * survives restarts, holds the child fan-out, and is what a signal addresses), while the database
 * row is the readable projection the UI queries. Without this activity the two drift — a workflow
 * would complete and the board would still show the card running, which is exactly the class of
 * bug the Temporal reconciliation loop exists to paper over for clusters.
 *
 * Writes only the fields it is given, because a card carries user-authored content (title, body)
 * that a workflow must never clobber — the same full-replace hazard that bites saveClusterInfo.
 */
import { createDatabase } from '../lib/db-interface.js';
import type { Card, CardAttempt, CardColumn, CardStatus } from '../lib/board.js';

export interface UpdateCardArgs {
  cardId: string;
  status?: CardStatus;
  column?: CardColumn;
  workflowId?: string;
  /**
   * Full attempt history, replacing whatever is stored.
   *
   * Replaced rather than appended because the WORKFLOW owns this list — it accumulates failures
   * across retries and passes the same array into the next attempt's context. Appending here too
   * would double-count on an activity retry, which is precisely the kind of duplication the
   * deterministic child ids elsewhere exist to prevent.
   */
  attempts?: CardAttempt[];
  /**
   * Consumption to ADD to whatever is stored, not replace.
   *
   * Opposite of `attempts` on purpose: the workflow owns the failure list and replaces it wholesale,
   * whereas tokens accrue across separate calls and each report is new spend. Replacing here would
   * silently discard everything but the last attempt's usage.
   */
  usage?: { tokens?: number; workspaces?: number; replans?: number };
}

export async function UpdateCardActivity(args: UpdateCardArgs): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    const cards = await db.getCards();
    const card = cards.find((c: Card) => c.id === args.cardId);
    // A card deleted while its workflow was still running is a normal race, not an error: the
    // delete already removed the subtree, and failing here would only produce a retry storm
    // against a row that is never coming back.
    if (!card) return;

    await db.saveCard({
      ...card,
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.column !== undefined ? { column: args.column } : {}),
      ...(args.workflowId !== undefined ? { workflowId: args.workflowId } : {}),
      ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
      ...(args.usage
        ? {
            usage: {
              tokens: (card.usage?.tokens ?? 0) + (args.usage.tokens ?? 0),
              workspaces: (card.usage?.workspaces ?? 0) + (args.usage.workspaces ?? 0),
              replans: (card.usage?.replans ?? 0) + (args.usage.replans ?? 0),
            },
          }
        : {}),
      updatedAt: new Date().toISOString(),
    });
  } finally {
    await db.close();
  }
}
