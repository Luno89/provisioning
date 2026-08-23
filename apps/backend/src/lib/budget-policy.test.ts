import { describe, it, expect } from 'vitest';
import { budgetForNewRoot, remainingFraction, DEFAULT_ROOT_BUDGET } from './budget-policy.js';
import { budgetExceeded } from './leaves.js';

/**
 * `LeafBudget` has been enforced since it was written and populated by nothing, ever — so the
 * ceiling could never trip, which reads exactly like a ceiling nobody reached. This is the
 * populator, and the risk it carries is the opposite one: a default that silently strangles real
 * work.
 */
describe('the budget a new request gets', () => {
  it('gives every root a budget, so the enforcement can fire at all', () => {
    expect(budgetForNewRoot().maxTokens).toBe(DEFAULT_ROOT_BUDGET.maxTokens);
  });

  it('lets an explicit number win, including a small one', () => {
    // Someone typing a number knows something the default does not.
    expect(budgetForNewRoot({ maxTokens: 5_000 }).maxTokens).toBe(5_000);
  });

  it('fills only the gaps in a partial budget', () => {
    const out = budgetForNewRoot({ maxTokens: 5_000 });
    expect(out.maxTokens).toBe(5_000);
    expect(out.maxWorkspaces).toBe(DEFAULT_ROOT_BUDGET.maxWorkspaces);
  });

  /**
   * The number that matters most on day one. A budget's first job is to make spend VISIBLE, not to
   * refuse things — tightening later against real numbers is easy, and discovering that a default
   * quietly strangled a week of work is not.
   *
   * Measured on this instance (sandbox-tools.ts): Builder's runs are 43k–604k tokens, median 149k.
   */
  it('sits well above a realistic request rather than in the middle of the distribution', () => {
    const medianLeafAttempt = 149_000;
    expect(DEFAULT_ROOT_BUDGET.maxTokens!).toBeGreaterThan(medianLeafAttempt * 15);
    // And above the largest single run ever recorded here, several times over.
    expect(DEFAULT_ROOT_BUDGET.maxTokens!).toBeGreaterThan(604_000 * 4);
  });

  it('does not refuse a request that has barely started', () => {
    const usage = { tokens: 200_000, completionTokens: 0, wallClockMs: 0, workspaces: 2, replans: 0 };
    expect(budgetExceeded(budgetForNewRoot(), usage)).toBeUndefined();
  });

  it('does refuse one that has genuinely run away', () => {
    // The concrete thing this bounds is an injected "create 10,000 subtasks".
    const usage = { tokens: 9_000_000, completionTokens: 0, wallClockMs: 0, workspaces: 500, replans: 0 };
    expect(budgetExceeded(budgetForNewRoot(), usage)).toMatch(/Token budget exhausted/);
  });
});

describe('how much is left', () => {
  it('reports a fraction the UI and the extension logic can share', () => {
    // One number, so the two cannot disagree about whether a budget is spent.
    expect(remainingFraction({ maxTokens: 100 }, 25)).toBe(0.75);
  });

  it('says nothing when nothing is enforced', () => {
    expect(remainingFraction(undefined, 100)).toBeUndefined();
    expect(remainingFraction({}, 100)).toBeUndefined();
  });

  it('never goes negative or above one', () => {
    expect(remainingFraction({ maxTokens: 100 }, 500)).toBe(0);
    expect(remainingFraction({ maxTokens: 100 }, -5)).toBe(1);
  });
});
