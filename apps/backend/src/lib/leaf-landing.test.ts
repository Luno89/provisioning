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
    expect(requestFinished([leaf(), leaf({ status: 'pending' })])).toBe(false);
  });

  it('is finished when everything has settled, however it settled', () => {
    expect(requestFinished([leaf(), leaf({ status: 'failed' }), leaf({ status: 'cancelled' })])).toBe(true);
  });

  it('does not wait on a proposal nobody accepted', () => {
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
    const older = leaf({ id: 'old', verified: true, outputBranch: 'koala/aaaaaaaa', createdAt: '2026-01-01T00:00:00Z' });
    const newer = leaf({ id: 'new', verified: true, outputBranch: 'koala/bbbbbbbb', createdAt: '2026-06-01T00:00:00Z' });

    expect(unlandedWork([newer, older]).map((l) => l.id)).toEqual(['old', 'new']);
  });
});
