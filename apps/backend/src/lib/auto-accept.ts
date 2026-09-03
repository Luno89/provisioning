import type { Leaf } from './leaves.js';

export const MAX_AUTO_ACCEPT = 8;
export const MIN_TITLE = 8;
export const MIN_BODY = 40;

export interface AutoAcceptPolicy {
  enabled: boolean;
  requirePersona: boolean;
  max: number;
  minTitleChars: number;
  minBodyChars: number;
}

export const DEFAULT_POLICY: AutoAcceptPolicy = {
  enabled: false,
  requirePersona: true,
  max: MAX_AUTO_ACCEPT,
  minTitleChars: MIN_TITLE,
  minBodyChars: MIN_BODY,
};

export interface Verdict {
  accept: boolean;
  reason: string;
}

export function review(
  leaf: Leaf,
  existing: Leaf[],
  policy: AutoAcceptPolicy = DEFAULT_POLICY,
): Verdict {
  if (leaf.status !== 'proposed') return { accept: false, reason: 'not a proposal' };

  const title = (leaf.title ?? '').trim();
  const body = (leaf.body ?? '').trim();

  if (title.length < policy.minTitleChars) {
    return { accept: false, reason: 'the title is too short to say what the work is' };
  }
  if (body.length < policy.minBodyChars) {
    return { accept: false, reason: 'there is no description of what to do' };
  }
  if (policy.requirePersona && !leaf.packId) {
    return { accept: false, reason: 'no persona was assigned, so the environment it would run in is undecided' };
  }

  const duplicate = existing.some((other) =>
    other.id !== leaf.id
    && other.status !== 'proposed'
    && (other.title ?? '').trim().toLowerCase() === title.toLowerCase());
  if (duplicate) {
    return { accept: false, reason: 'a leaf with this title has already been accepted' };
  }

  return { accept: true, reason: 'well-formed, assigned and not already being done' };
}

export interface Reviewed {
  leaf: Leaf;
  verdict: Verdict;
}

export function reviewBatch(
  proposals: Leaf[],
  existing: Leaf[],
  policy: AutoAcceptPolicy = DEFAULT_POLICY,
): Reviewed[] {
  if (!policy.enabled) {
    return proposals.map((leaf) => ({ leaf, verdict: { accept: false, reason: 'auto-accept is off' } }));
  }
  if (proposals.length > policy.max) {
    return proposals.map((leaf) => ({
      leaf,
      verdict: {
        accept: false,
        reason: `${proposals.length} proposals at once is more than the ${policy.max} that may start unattended`,
      },
    }));
  }

  const seen = [...existing];
  return proposals.map((leaf) => {
    const verdict = review(leaf, seen, policy);
    if (verdict.accept) seen.push({ ...leaf, status: 'pending' });
    return { leaf, verdict };
  });
}
