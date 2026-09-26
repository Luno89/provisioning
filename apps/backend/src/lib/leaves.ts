export type LeafStatus = 'pending' | 'running' | 'claimed' | 'succeeded' | 'failed' | 'cancelled';

export interface LeafAttempt {
  attempt: number;
  error: string;
  failedAt: string;
}

export interface Leaf {
  id: string;
  ownerId: string;
  branchId: string;
  title: string;
  body?: string;
  status: LeafStatus;
  dependsOn?: string[];
  replans?: number | undefined;
  tasks?: string[];
  findings?: string;
  claim?: {
    evidence: string;
    commit?: string;
    findings?: string;
    runs?: string[];
    at: string;
  };
  verified?: boolean;
  review?: {
    verdict: 'sound' | 'concern' | 'unsound';
    model?: string;
    at: string;
    reason?: string;
  };
  attempts?: LeafAttempt[];
  createdAt: string;
  updatedAt: string;
}

export interface Branch {
  id: string;
  ownerId: string;
  treeId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export const awaitingReview = (leaf: Pick<Leaf, 'status' | 'claim' | 'review'>): boolean =>
  leaf.status === 'claimed' && leaf.claim !== undefined && leaf.review !== undefined && leaf.review.at >= leaf.claim.at;

export type ClaimVerdict = 'verified' | 'stay-claimed' | 'failed';

export function settleClaim(
  leaf: Leaf,
  settlement: { verdict: ClaimVerdict; note?: string | undefined; by?: string | undefined; at: string },
): { leaf: Leaf; digest: string } | { problem: string } {
  const { verdict, note, by, at } = settlement;
  if (verdict === 'failed' && !note) return { problem: 'a failed settlement needs a reason — what the evidence shows the goal is missing, so the replan can pick an angle' };
  if (leaf.status !== 'claimed' || !leaf.claim) {
    return { problem: `${leaf.id} is not awaiting judgment — it is ${leaf.status}. Only a claimed leaf with evidence on file gets settled; the judge pass judges claims, not raw or finished leaves.` };
  }

  const settled: Leaf = { ...leaf, updatedAt: at };
  const verdictBy = (kind: 'sound' | 'unsound') => ({ verdict: kind, at, ...(note ? { reason: note } : {}), ...(by ? { model: by } : {}) });
  if (verdict === 'verified') {
    settled.status = 'succeeded';
    settled.verified = true;
    settled.review = verdictBy('sound');
    if (note) settled.findings = note;
    return { leaf: settled, digest: `settled ${leaf.id} — verified` };
  }
  if (verdict === 'failed') {
    settled.status = 'failed';
    settled.verified = false;
    settled.review = verdictBy('unsound');
    settled.findings = note!;
    return { leaf: settled, digest: `settled ${leaf.id} — failed` };
  }
  settled.review = { verdict: 'concern', at, ...(note ? { reason: note } : {}), ...(by ? { model: by } : {}) };
  return { leaf: settled, digest: note ? `kept ${leaf.id} claimed for a person to review — ${note}` : `kept ${leaf.id} claimed for a person to review` };
}

export function resetForRetry<T extends { status: string; updatedAt: string }>(
  leaf: Leaf,
  tasks: readonly T[],
  at: string,
): { leaf: Leaf; tasks: T[] } {
  const attempts = leaf.attempts ?? [];
  const failure = leaf.findings ?? leaf.claim?.evidence ?? 'failed';
  const { claim: _claim, review: _review, ...rest } = leaf;
  return {
    leaf: {
      ...rest,
      status: 'pending',
      verified: false,
      attempts: [...attempts, { attempt: attempts.length + 1, error: failure, failedAt: leaf.updatedAt }],
      updatedAt: at,
    },
    tasks: tasks.filter((task) => task.status === 'failed').map((task) => ({ ...task, status: 'accepted', updatedAt: at })),
  };
}
