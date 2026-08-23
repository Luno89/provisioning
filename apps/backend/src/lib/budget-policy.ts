/**
 * What a request is allowed to cost, when nobody said.
 *
 * ── WHY A DEFAULT AND NOT AN ESTIMATE ──
 * `LeafBudget` has been enforced since it was written — `budgetExceeded` and `aggregateUsage` are
 * wired into `accept-leaf.ts` and the leaf-creation route — and populated by nothing, ever. So the
 * ceiling could never trip, which reads exactly like a ceiling that was never reached. This is the
 * populator.
 *
 * The obvious alternative is to estimate per request from its description, and the abandoned
 * harness-v2 branch shipped exactly that: keyword matching on the title. It gives
 * "fix the auth flow across three services" the SMALLEST budget in its table because the string
 * contains "fix", and gives a 501-character description of a typo correction the middle one. That
 * is not complexity estimation, it is vocabulary matching wearing its clothes — and being wrong in
 * that direction means refusing real work while waving through trivia.
 *
 * A flat default a human can see and raise is worse on average and better in the tail, which is the
 * right trade for a ceiling. It is also honest: nobody is pretending to know how big the job is.
 *
 * ── HOW THE NUMBERS WERE CHOSEN ──
 * From what runs on this instance actually cost, recorded in sandbox-tools.ts: Builder's runs range
 * 43k to 604k tokens with a median of 149k. So one leaf-attempt is ~150k, a leaf that retries is up
 * to ~1.8M under MAX_AGENT_TOKENS, and a request is usually several leaves.
 *
 * These sit ABOVE the largest plausible honest request rather than in the middle of the
 * distribution. A budget that routinely stops real work is the thing being fixed, not reproduced
 * with a different unit — the first version of this must refuse almost nothing, because its job on
 * day one is to make spend VISIBLE. Tightening later against real numbers is easy; discovering that
 * a default silently strangled a week of work is not.
 */
import type { LeafBudget } from './leaves.js';

/**
 * Roughly twenty median leaf-attempts across a whole request tree.
 *
 * Enough for a decomposed request whose leaves each retry, and far below a runaway: the concrete
 * thing this bounds is an injected "create 10,000 subtasks", where depth and fan-out caps alone
 * still permit 3 × 10 × 10 = 300 workspaces.
 */
export const DEFAULT_ROOT_BUDGET: LeafBudget = {
  maxTokens: 3_000_000,
  maxWallClockMs: 6 * 60 * 60 * 1000,
  maxWorkspaces: 40,
  /** A planner that answers failure by generating more work is looping, not planning. */
  maxReplans: 5,
};

/**
 * The budget a newly created ROOT leaf should carry.
 *
 * Only roots, because the budget is deliberately a subtree-wide ceiling — see LeafBudget. A
 * per-leaf budget bounds nothing: depth and fan-out caps still permit hundreds of leaves, each
 * comfortably inside its own limit.
 *
 * An explicitly supplied budget always wins, including a deliberately small one. Someone typing a
 * number knows something the default does not.
 */
export function budgetForNewRoot(supplied?: Partial<LeafBudget>): LeafBudget {
  return { ...DEFAULT_ROOT_BUDGET, ...(supplied ?? {}) };
}

/**
 * What is left, as a fraction. `undefined` when nothing is enforced.
 *
 * Exists so the UI and the extension logic agree about the same number rather than each computing
 * "remaining" from the raw pair — which is how one of them ends up reporting a budget as spent
 * while the other still allows work.
 */
export function remainingFraction(budget: LeafBudget | undefined, tokensUsed: number): number | undefined {
  if (budget?.maxTokens === undefined || budget.maxTokens <= 0) return undefined;
  return Math.max(0, Math.min(1, 1 - tokensUsed / budget.maxTokens));
}
