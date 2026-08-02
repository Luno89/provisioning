/**
 * ExecuteCardActivity — where a card's actual work happens.
 *
 * ── THE ARGUMENT IS JUST AN ID ──
 * This takes a cardId and nothing else. Everything it needs — the card, its body, its failure
 * history, and eventually retrieved memory — is read from MongoDB at execution time.
 *
 * That is what makes Temporal's own retry policy usable. The objection to native retries is that
 * they replay identical input, so an agent task fails identically every attempt. That is only true
 * when the context IS the input. Here the input is `{ cardId }` on every attempt while the context
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
import { failureContext, type Card, type CardAttempt } from '../lib/board.js';

export interface ExecuteCardArgs {
  cardId: string;
}

export interface ExecuteCardResult {
  cardId: string;
  /** Tokens consumed by this attempt, folded into the root's budget by the caller. */
  tokensUsed: number;
  summary: string;
}

/**
 * Assembles everything a persona needs to act on a card.
 *
 * Exported so the prompt-building can be tested without running an activity, and so Phase C adds
 * retrieval sources here rather than changing the workflow contract.
 */
export function buildCardContext(card: Card, priorFailures: CardAttempt[]): string {
  const parts = [`Task: ${card.title}`];
  if (card.body) parts.push(card.body);

  // The whole point of retrying. Without this the next attempt is identical to the one that just
  // failed, which is exactly what Temporal's built-in retry would give for free.
  const failures = failureContext(priorFailures);
  if (failures) parts.push(failures);

  return parts.join('\n\n');
}

export async function ExecuteCardActivity(args: ExecuteCardArgs): Promise<ExecuteCardResult> {
  // Falls back to 1 outside an activity context, so the function stays callable from a test.
  const attemptNumber = Context.current?.()?.info?.attempt ?? 1;

  const db = createDatabase();
  await db.init();
  try {
    const card = (await db.getCards()).find((c: Card) => c.id === args.cardId);
    // A card deleted mid-flight is a normal race, not an error — failing would only produce a
    // retry storm against a row that is never coming back.
    if (!card) return { cardId: args.cardId, tokensUsed: 0, summary: 'Card no longer exists' };

    const priorFailures = card.attempts ?? [];
    const context = buildCardContext(card, priorFailures);

    try {
      // Phase C replaces this with a persona: route to a model, run the agent CLI in a workspace,
      // commit, push. The surrounding shape — read context, record failure, report tokens — is what
      // is being established now, so that change is an implementation rather than a redesign.
      if (!card.personaId) {
        return {
          cardId: card.id,
          tokensUsed: 0,
          summary: `No persona assigned; nothing to execute. Context was ${context.length} characters.`,
        };
      }
      throw new Error(`Persona "${card.personaId}" is not implemented yet (Phase C)`);
    } catch (err: any) {
      // Written BEFORE rethrowing, so Temporal's retry re-reads a database this attempt changed.
      const attempts: CardAttempt[] = [
        ...priorFailures,
        {
          // Read from the activity context, not passed in: an argument would be baked into
          // workflow history at the first call and stay 1 forever, mislabelling every retry.
          // Temporal counts attempts from 1; CardAttempt counts from 0.
          attempt: Math.max(0, attemptNumber - 1),
          error: String(err?.message ?? err).slice(0, 2000),
          failedAt: new Date().toISOString(),
        },
      ];
      const latest = (await db.getCards()).find((c: Card) => c.id === args.cardId);
      if (latest) await db.saveCard({ ...latest, attempts, status: 'failed', updatedAt: new Date().toISOString() });
      throw err;
    }
  } finally {
    await db.close();
  }
}
