import { describe, it, expect } from 'vitest';
import { awaitingReview, resetForRetry, settleClaim, type Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'A leaf', body: 'the port answers', status: 'pending',
  createdAt: 't0', updatedAt: 't0', ...over,
});
const claimed = (over: Partial<Leaf> = {}) => leaf({ status: 'claimed', claim: { evidence: 'curl printed ok', at: 't1' }, ...over });

describe('settling a claim', () => {
  it('verifies a claimed leaf and keeps the note as its findings', () => {
    const outcome = settleClaim(claimed(), { verdict: 'verified', note: 'saw it answer', by: 'judge', at: 't2' });
    expect(outcome).toMatchObject({ leaf: { status: 'succeeded', verified: true, findings: 'saw it answer', review: { verdict: 'sound', model: 'judge', at: 't2' } } });
  });

  it('fails a claimed leaf only with a reason', () => {
    expect(settleClaim(claimed(), { verdict: 'failed', at: 't2' })).toMatchObject({ problem: expect.stringMatching(/needs a reason/) });
    expect(settleClaim(claimed(), { verdict: 'failed', note: 'no listener', at: 't2' })).toMatchObject({ leaf: { status: 'failed', verified: false, findings: 'no listener' } });
  });

  it('keeps a leaf claimed with a concern, which parks it for a person', () => {
    const outcome = settleClaim(claimed(), { verdict: 'stay-claimed', note: 'port never probed', at: 't2' });
    expect(outcome).toMatchObject({ leaf: { status: 'claimed', review: { verdict: 'concern', reason: 'port never probed' } } });
    expect('leaf' in outcome && awaitingReview(outcome.leaf)).toBe(true);
  });

  it('refuses a leaf that has no claim on file', () => {
    expect(settleClaim(leaf(), { verdict: 'verified', at: 't2' })).toMatchObject({ problem: expect.stringMatching(/not awaiting judgment/) });
  });
});

describe('awaiting review', () => {
  it('is a claim the judge has reviewed since it was filed', () => {
    expect(awaitingReview(claimed())).toBe(false);
    expect(awaitingReview(claimed({ review: { verdict: 'concern', at: 't0' } }))).toBe(false);
    expect(awaitingReview(claimed({ review: { verdict: 'concern', at: 't1' } }))).toBe(true);
  });
});

describe('retrying a failed leaf', () => {
  it('puts it back to pending, records the attempt and reopens only its failed tasks', () => {
    const failed = leaf({ status: 'failed', findings: 'no listener', updatedAt: 't1', claim: { evidence: 'e', at: 't1' }, review: { verdict: 'unsound', at: 't1' } });
    const tasks = [{ id: 'k1', status: 'failed', updatedAt: 't1' }, { id: 'k2', status: 'done', updatedAt: 't1' }];
    const { leaf: reset, tasks: reopened } = resetForRetry(failed, tasks, 't2');
    expect(reset).toMatchObject({ status: 'pending', verified: false, attempts: [{ attempt: 1, error: 'no listener', failedAt: 't1' }], updatedAt: 't2' });
    expect(reset.claim).toBeUndefined();
    expect(reset.review).toBeUndefined();
    expect(reopened).toEqual([{ id: 'k1', status: 'accepted', updatedAt: 't2' }]);
  });
});
