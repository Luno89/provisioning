import type { Leaf } from './leaves.js';

export interface BranchFacts {
  exists: boolean;
  found: string[];
  missing: string[];
  commitsAhead?: number;
}

export type RecheckVerdict =
  | { outcome: 'verified'; reason: string }
  | { outcome: 'needs-a-look'; reason: string }
  | { outcome: 'still-failed'; reason: string }
  | { outcome: 'not-applicable'; reason: string };

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
    return {
      outcome: 'needs-a-look',
      reason: `Could not find branch ${leaf.outputBranch}. It may have been deleted after a merge, or `
        + 'this project\'s repository may not be where the leaf thinks it is — either way nothing here '
        + 'can tell, so it has not been marked as anything.',
    };
  }

  const promised = leaf.expects ?? [];

  if (promised.length === 0) {
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

export function statusAfterRecheck(verdict: RecheckVerdict): Partial<Leaf> | undefined {
  if (verdict.outcome !== 'verified') return undefined;
  return { status: 'succeeded', verified: true, merged: false };
}
