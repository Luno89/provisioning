/**
 * Counting what a leaf actually consumed.
 *
 * ── WHY THIS IS NOT INLINE AT EACH CALL SITE ──
 * `budgetExceeded` (leaves.ts) compares `aggregateUsage` against `LeafBudget`, and a budget is only
 * as meaningful as the count is complete. `usage.workspaces` was declared, aggregated and compared
 * against `maxWorkspaces` — and incremented by nothing, anywhere, so that ceiling could never trip.
 * A partial count is worse than no count: it reads like a measurement.
 *
 * Three activities create a sandbox, in three different shapes — one folds the number into a save
 * it was already making, two need a targeted write. The additive read-modify-write lives here so
 * those three cannot drift into two different meanings of "one workspace".
 *
 * Deliberately NOT called by ExperimentService: its sandboxes belong to a variant run, not to a
 * leaf, and attributing them to whatever leaf happened to be nearby would poison a root's budget
 * with spend the tree never asked for.
 */
import type { Database } from './db-interface.js';
import type { Leaf } from './leaves.js';

/**
 * Records one more sandbox against a leaf.
 *
 * Re-reads before writing: these callers hold a leaf object from the top of an activity that has
 * since been running for minutes, and `saveLeaf` is a full replace. Never fatal — a sandbox that
 * ran and could not be counted is still a sandbox that ran, and failing the activity over the
 * bookkeeping would trade real work for a number.
 */
export async function countWorkspace(db: Database, leafId: string): Promise<void> {
  try {
    const leaf = (await db.getLeaves()).find((l: Leaf) => l.id === leafId);
    // Deleted mid-run is a normal race, not an error — the subtree is already gone.
    if (!leaf) return;

    await db.saveLeaf({
      ...leaf,
      usage: { ...(leaf.usage ?? {}), workspaces: (leaf.usage?.workspaces ?? 0) + 1 },
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn(`[leaf-usage] could not count a workspace for ${leafId}: ${err?.message ?? err}`);
  }
}
