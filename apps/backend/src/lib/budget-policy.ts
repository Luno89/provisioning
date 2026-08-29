import type { LeafBudget } from './leaves.js';

export const DEFAULT_ROOT_BUDGET: LeafBudget = {
  maxTokens: 3_000_000,
  maxWallClockMs: 6 * 60 * 60 * 1000,
  maxWorkspaces: 40,
  maxReplans: 5,
};

export function budgetForNewRoot(supplied?: Partial<LeafBudget>): LeafBudget {
  return { ...DEFAULT_ROOT_BUDGET, ...(supplied ?? {}) };
}

export function remainingFraction(budget: LeafBudget | undefined, tokensUsed: number): number | undefined {
  if (budget?.maxTokens === undefined || budget.maxTokens <= 0) return undefined;
  return Math.max(0, Math.min(1, 1 - tokensUsed / budget.maxTokens));
}
