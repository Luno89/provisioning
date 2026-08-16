/**
 * Looking again at a failure, to see whether the work is actually there.
 *
 * ── WHY THIS IS NEEDED ──
 * A leaf wrote 30 passing tests, committed them, pushed them to `koala/7565dc49` — and then hit its
 * step ceiling before calling `finish`. Nothing could check it, so `decideStatus` fell back to the
 * agent's claim, and a run that never got to make a claim has none. It was recorded as failed and
 * the branch was never merged. The work has been sitting there ever since.
 *
 * The wrap-up turn stops this happening again. It does nothing for the failures already on record,
 * and those are the ones with code stranded on a branch right now.
 *
 * ── THE LINE THIS MUST NOT CROSS ──
 * "There are commits on a branch" is NOT evidence that the task was done. Promoting a leaf on that
 * basis would launder the exact claim this whole system is arranged to keep separate — it is the
 * same mistake as trusting `succeeded` over `verified`, made in a new place and harder to see.
 *
 * So a recheck promotes a leaf ONLY when something real can be checked: the files it promised are
 * present on the branch. When a leaf promised nothing checkable, the recheck reports what is there
 * and changes nothing. That is not a cop-out — it is the honest answer, and it puts a person in
 * front of the one decision a machine cannot make here.
 */
import type { Leaf } from './leaves.js';

export interface BranchFacts {
  /** Whether the branch named on the leaf still exists. */
  exists: boolean;
  /** Files the leaf promised, and whether each is present and non-empty on that branch. */
  found: string[];
  missing: string[];
  /** Commits on the branch that are not on the default branch, when it could be worked out. */
  commitsAhead?: number;
}

export type RecheckVerdict =
  /** The promised files are there. This is the artifact check, run late. */
  | { outcome: 'verified'; reason: string }
  /** Work exists but nothing here can judge it. Status unchanged; a person decides. */
  | { outcome: 'needs-a-look'; reason: string }
  /** Checked, and the work genuinely is not there. */
  | { outcome: 'still-failed'; reason: string }
  /** Nothing to recheck. */
  | { outcome: 'not-applicable'; reason: string };

/** Whether a recheck could tell us anything at all. */
export function canRecheck(leaf: Pick<Leaf, 'status' | 'outputBranch'>): boolean {
  return leaf.status === 'failed' && Boolean(leaf.outputBranch);
}

export function recheckVerdict(
  leaf: Pick<Leaf, 'status' | 'outputBranch' | 'expects' | 'title'>,
  facts: BranchFacts,
): RecheckVerdict {
  if (leaf.status !== 'failed') {
    return { outcome: 'not-applicable', reason: 'Only a failed leaf is worth rechecking.' };
  }
  if (!leaf.outputBranch) {
    return { outcome: 'not-applicable', reason: 'This leaf never pushed a branch, so there is nothing to look at.' };
  }
  if (!facts.exists) {
    /**
     * A branch that cannot be found is NOT a verdict.
     *
     * It is what a wrong repository lookup looks like, what an unreachable Gitea looks like, and
     * what a genuinely deleted branch looks like — and they are indistinguishable from here. This
     * originally returned `still-failed`, and the first time it ran for real a bad owner/repo
     * lookup produced a confident "the branch no longer exists" for two leaves whose branches were
     * intact. Saying "I could not find it" is the only honest answer, and it is the one that gets
     * someone to check rather than to believe.
     */
    return {
      outcome: 'needs-a-look',
      reason: `Could not find branch ${leaf.outputBranch}. It may have been deleted after a merge, or `
        + 'this project\'s repository may not be where the leaf thinks it is — either way nothing here '
        + 'can tell, so it has not been marked as anything.',
    };
  }

  const promised = leaf.expects ?? [];

  if (promised.length === 0) {
    /**
     * The case the lost leaf is in. There is a branch, there may well be finished work on it, and
     * nothing was declared that could confirm it — so this reports and stops.
     */
    const ahead = facts.commitsAhead;
    return {
      outcome: 'needs-a-look',
      reason: `There is work on ${leaf.outputBranch}`
        + (ahead !== undefined ? ` (${ahead} commit${ahead === 1 ? '' : 's'} ahead of the default branch)` : '')
        + ', but this leaf promised no files, so nothing here can confirm whether the task was done.'
        + ' Someone has to look.',
    };
  }

  if (facts.missing.length === 0) {
    return {
      outcome: 'verified',
      reason: `Every file this leaf promised is present on ${leaf.outputBranch}: ${facts.found.join(', ')}.`
        + ' It did the work and ran out of budget before it could say so.',
    };
  }

  if (facts.found.length > 0) {
    // Partial. Not a pass, and not nothing — the difference decides whether a retry starts over.
    return {
      outcome: 'needs-a-look',
      reason: `Some of the promised files are on ${leaf.outputBranch} (${facts.found.join(', ')}) and some are not `
        + `(${facts.missing.join(', ')}). The work is part-done rather than absent.`,
    };
  }

  return {
    outcome: 'still-failed',
    reason: `None of the promised files are on ${leaf.outputBranch}: ${facts.missing.join(', ')} are all missing.`,
  };
}

/** What the leaf record should become. `undefined` means leave it exactly as it is. */
export function statusAfterRecheck(verdict: RecheckVerdict): Partial<Leaf> | undefined {
  if (verdict.outcome !== 'verified') return undefined;
  /**
   * Verified, but NOT merged.
   *
   * Merging is a separate act with its own failure modes, and doing it silently as a side effect of
   * a recheck would land code on the default branch that nobody asked to land. `verified` without
   * `merged` is an existing, meaningful state: the work holds together and is waiting on a person.
   */
  return { status: 'succeeded', verified: true, merged: false };
}
