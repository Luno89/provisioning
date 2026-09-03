import type { BudgetConfig } from '@koala/harness-types';

interface PackRowStore {
  getPersonaPacks(): Promise<{
    slug: string;
    ownerId?: string | undefined;
    budget?: BudgetConfig;
  }[]>;
}

/**
 * The one remaining caller (`ExecuteLeafActivity`'s dangling-`packId` graceful-degradation path)
 * intentionally keeps running a leaf with no resolvable pack rather than failing it outright — see
 * that file's "runs with no pack when the id dangles" behavior. Every other former caller now
 * requires an explicit, resolved pack and fails loud instead of reaching for koala's budget.
 */
export async function requireBudget(store: PackRowStore, userId?: string): Promise<BudgetConfig> {
  const rows = await store.getPersonaPacks();
  const builtIn = rows.find((p) => p.slug === 'koala' && p.ownerId == null);
  const owned = userId ? rows.find((p) => p.slug === 'koala' && p.ownerId === userId) : undefined;
  const budget = (owned ?? builtIn)?.budget;
  if (!budget) {
    throw new Error('No pack budget: nothing is seeded. Run the seeder (scripts/seed-all.ts).');
  }
  return budget;
}
