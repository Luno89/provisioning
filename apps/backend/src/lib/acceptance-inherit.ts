import { usableAcceptancePlan, type AcceptanceCheck } from './acceptance.js';

/**
 * A new branch starting with the acceptance plan its tree already uses.
 *
 * ── THE DEAD END THIS ENDS ──
 * Nothing may be accepted on a branch with no acceptance plan — a rule worth keeping, because the
 * alternative is a run that reports success on pieces that were never assembled and tried.
 *
 * But the plan is stored per BRANCH, and only the planner ever sets one, during planning. So a
 * FOLLOW-UP branch was born unacceptable and nothing said why. Measured on the live database:
 *
 *     tree 1f63acec   branch 1: acceptance=1    branch 2: acceptance=0, 1 leaf stuck
 *     tree ad8bc552   branch 1: acceptance=1    branch 2: acceptance=0, 2 leaves stuck
 *
 * Every first branch had a plan and every second had none, with its leaves stuck at `proposed`.
 *
 * ── WHY INHERITING IS THE RIGHT DEFAULT ──
 * A tree is one effort against one repository. A second branch of it is more work on the same
 * deliverable, and the acceptance plan checks that deliverable — "install it, run it, call it" is
 * as true on the fourth conversation as the first.
 *
 * A default, not a decision: the plan is editable afterwards, and a planner that sets its own
 * replaces this outright. What it removes is the state where a person has no way forward at all.
 */

interface BranchLike {
  treeId?: string | undefined;
  acceptance?: unknown;
  updatedAt?: string | undefined;
  createdAt?: string | undefined;
}

/**
 * The plan a new branch of `treeId` should start with, or `[]` when there is nothing to inherit.
 *
 * Takes the MOST RECENT usable plan rather than the first: a tree whose acceptance was revised
 * should hand on the revision, and the oldest branch is the least likely to still be right.
 */
export function inheritedAcceptance(
  treeId: string | undefined,
  branches: readonly BranchLike[],
): AcceptanceCheck[] {
  if (!treeId) return [];
  const when = (b: BranchLike) => b.updatedAt ?? b.createdAt ?? '';
  const candidates = branches
    .filter((b) => b.treeId === treeId)
    .map((b) => ({ at: when(b), plan: usableAcceptancePlan(b.acceptance) }))
    // A branch whose plan is empty or unusable has nothing to pass on; it must not shadow one
    // further back that does.
    .filter((c) => c.plan.length > 0)
    .sort((a, b) => b.at.localeCompare(a.at));
  return candidates[0]?.plan ?? [];
}
