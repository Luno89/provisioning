import type { BudgetConfig, SamplingConfig } from '@koala/harness-types';

interface PackRowStore {
  getPersonaPacks(): Promise<{
    slug: string;
    ownerId?: string | undefined;
    sampling?: SamplingConfig;
    budget?: BudgetConfig;
  }[]>;
}

/**
 * The pack a caller runs as when it names none — a plain chat turn, a probe, the suite author. It
 * is the shipped `koala` row, so every value is a record the user can edit and nothing falls back
 * to a module constant. Undefined only when the seeder has not run.
 */
async function defaultPack(store: PackRowStore) {
  const rows = await store.getPersonaPacks();
  return rows.find((p) => p.slug === 'koala' && p.ownerId === undefined);
}

export async function defaultSampling(store: PackRowStore): Promise<SamplingConfig | undefined> {
  return (await defaultPack(store))?.sampling;
}

export async function defaultBudget(store: PackRowStore): Promise<BudgetConfig | undefined> {
  return (await defaultPack(store))?.budget;
}

/**
 * Same, but for a caller that cannot proceed without one. An unseeded database used to surface far
 * downstream as a request with no token cap; this says which command was not run.
 */
export async function requireBudget(store: PackRowStore): Promise<BudgetConfig> {
  const budget = await defaultBudget(store);
  if (!budget) {
    throw new Error('No pack budget: nothing is seeded. Run the seeder (scripts/seed-all.ts).');
  }
  return budget;
}
