/**
 * The sweep that runs when a request finishes.
 *
 * A leaf merges itself the moment it verifies, and for a chain that always works — each leaf
 * contains its predecessor, so every merge fast-forwards. Parallel leaves are the gap: two branches
 * cut independently can touch the same file, and the second merge is abandoned rather than forced.
 * That work ends up verified, intact, and nowhere anybody looks.
 */
import { describe, it, expect } from 'vitest';
import { requestFinished, unlandedWork, type Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l', ownerId: 'u1', branchId: 'b', title: 't', body: '', column: 'todo',
  status: 'succeeded', depth: 0, blocking: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '', ...over,
} as Leaf);

describe('when a request counts as finished', () => {
  it('waits while anything is still running', () => {
    expect(requestFinished([leaf(), leaf({ status: 'running' })])).toBe(false);
  });

  it('waits while anything is still pending', () => {
    // Including a leaf parked on the dependency gate — its work has not happened yet.
    expect(requestFinished([leaf(), leaf({ status: 'pending' })])).toBe(false);
  });

  it('is finished when everything has settled, however it settled', () => {
    expect(requestFinished([leaf(), leaf({ status: 'failed' }), leaf({ status: 'cancelled' })])).toBe(true);
  });

  it('does not wait on a proposal nobody accepted', () => {
    // Otherwise a request never finishes because somebody declined a suggestion.
    expect(requestFinished([leaf(), leaf({ status: 'proposed' })])).toBe(true);
  });
});

describe('what the sweep should land', () => {
  it('picks up verified work that never merged', () => {
    const stuck = leaf({ id: 'a', verified: true, merged: false, outputBranch: 'koala/aaaaaaaa' });
    expect(unlandedWork([stuck]).map((l) => l.id)).toEqual(['a']);
  });

  it('leaves alone what already landed', () => {
    expect(unlandedWork([leaf({ verified: true, merged: true, outputBranch: 'koala/aaaaaaaa' })])).toEqual([]);
  });

  it('never lands work nothing checked', () => {
    // The whole contract of `verified`: an unverified success is a claim, and the sweep is not a
    // way around the gate that keeps claims off the default branch.
    expect(unlandedWork([leaf({ verified: false, outputBranch: 'koala/aaaaaaaa' })])).toEqual([]);
  });

  it('ignores a leaf that pushed nothing', () => {
    expect(unlandedWork([leaf({ verified: true, merged: false })])).toEqual([]);
  });

  it('ignores failed and cancelled leaves', () => {
    const dead = leaf({ status: 'failed', verified: true, outputBranch: 'koala/aaaaaaaa' });
    expect(unlandedWork([dead])).toEqual([]);
  });

  it('lands oldest first', () => {
    // The order most likely to apply cleanly: a later leaf was probably built beside the earlier
    // one, not before it.
    const older = leaf({ id: 'old', verified: true, outputBranch: 'koala/aaaaaaaa', createdAt: '2026-01-01T00:00:00Z' });
    const newer = leaf({ id: 'new', verified: true, outputBranch: 'koala/bbbbbbbb', createdAt: '2026-06-01T00:00:00Z' });

    expect(unlandedWork([newer, older]).map((l) => l.id)).toEqual(['old', 'new']);
  });
});
