import { describe, it, expect } from 'vitest';
import { needsYou, running, changedSince, treeRollups, ago, scopeToTree, groupWork, settledBranches, outstandingWork } from './home-summary.js';
import type { Leaf } from './leaf-types.js';

const leaf = (over: Partial<Leaf>): Leaf => ({
  id: 'l', branchId: 'b1', title: 't', status: 'succeeded',
  depth: 0, blocking: true, childCount: 0, updatedAt: '2026-08-01T00:00:00Z', ...over,
} as Leaf);

describe('what needs you', () => {
  it('puts work already spent ahead of a decision not yet made', () => {
    const out = needsYou([
      leaf({ id: 'p', status: 'proposed' }),
      leaf({ id: 'f', status: 'failed' }),
    ]);
    expect(out.map((a) => a.leaf.id)).toEqual(['f', 'p']);
  });

  it('puts the most-attempted failure first', () => {
    const three = leaf({ id: 'three', status: 'failed', attempts: [1, 2, 3].map((n) => ({ attempt: n, error: 'e', failedAt: '' })) });
    const one = leaf({ id: 'one', status: 'failed', attempts: [{ attempt: 0, error: 'e', failedAt: '' }] });
    expect(needsYou([one, three]).map((a) => a.leaf.id)).toEqual(['three', 'one']);
  });

  it('leaves finished and running work off the list entirely', () => {
    const out = needsYou([
      leaf({ status: 'succeeded' }), leaf({ status: 'running' }),
      leaf({ status: 'pending' }), leaf({ status: 'cancelled' }),
    ]);
    expect(out).toEqual([]);
  });

  it('survives an attempts field that is a count rather than an array', () => {
    const odd = { ...leaf({ id: 'x', status: 'failed' }), attempts: 3 } as unknown as Leaf;
    expect(() => needsYou([odd])).not.toThrow();
    expect(needsYou([odd])).toHaveLength(1);
  });
});

describe('what is running', () => {
  it('is only work actually in a sandbox', () => {
    const out = running([
      leaf({ id: 'live', status: 'running' }),
      leaf({ id: 'queued', status: 'pending' }),
      leaf({ id: 'proposed', status: 'proposed' }),
      leaf({ id: 'done', status: 'succeeded' }),
    ]);
    expect(out.map((l) => l.id)).toEqual(['live']);
  });

  it('is empty rather than undefined when nothing runs', () => {
    expect(running([])).toEqual([]);
  });
});

describe('what changed while you were away', () => {
  it('excludes work that is still running', () => {
    const out = changedSince([
      leaf({ id: 'done', updatedAt: '2026-08-02T00:00:00Z' }),
      leaf({ id: 'live', status: 'running', updatedAt: '2026-08-02T00:00:00Z' }),
    ], '2026-08-01T00:00:00Z');
    expect(out.map((l) => l.id)).toEqual(['done']);
  });

  it('shows nothing rather than everything when there is no last-looked time', () => {
    expect(changedSince([leaf({}), leaf({})], undefined)).toEqual([]);
  });

  it('is newest first', () => {
    const out = changedSince([
      leaf({ id: 'old', updatedAt: '2026-08-02T00:00:00Z' }),
      leaf({ id: 'new', updatedAt: '2026-08-03T00:00:00Z' }),
    ], '2026-08-01T00:00:00Z');
    expect(out.map((l) => l.id)).toEqual(['new', 'old']);
  });
});

describe('per-tree progress', () => {
  const trees = [{ id: 't1', name: 'Weather' }];
  const branches = [{ id: 'b1', treeId: 't1' }, { id: 'bx', treeId: 'other' }];

  it('never folds a claim into a verification', () => {
    const r = treeRollups(trees, branches, [
      leaf({ id: '1', branchId: 'b1', status: 'succeeded', verified: true }),
      leaf({ id: '2', branchId: 'b1', status: 'succeeded', verified: false }),
    ])[0]!;
    expect(r.verified).toBe(1);
    expect(r.claimed).toBe(1);
  });

  it('counts a failure as still outstanding', () => {
    const r = treeRollups(trees, branches, [
      leaf({ id: '1', branchId: 'b1', status: 'succeeded', verified: true }),
      leaf({ id: '2', branchId: 'b1', status: 'failed' }),
    ])[0]!;
    expect(r.failed).toBe(1);
    expect(r.outstanding).toBe(1);
  });

  it('ignores cancelled work rather than counting it as left to do', () => {
    const r = treeRollups(trees, branches, [
      leaf({ id: '1', branchId: 'b1', status: 'succeeded', verified: true }),
      leaf({ id: '2', branchId: 'b1', status: 'cancelled' }),
    ])[0]!;
    expect(r.total).toBe(1);
    expect(r.outstanding).toBe(0);
  });

  it('does not count another tree\'s leaves', () => {
    const r = treeRollups(trees, branches, [leaf({ id: '1', branchId: 'bx', status: 'succeeded', verified: true })])[0]!;
    expect(r.total).toBe(0);
  });

  it('keeps a tree that has never run anything', () => {
    const r = treeRollups(trees, branches, []);
    expect(r).toHaveLength(1);
    expect(r[0]!.total).toBe(0);
  });
});

describe('relative time', () => {
  const now = new Date('2026-08-16T12:00:00Z').getTime();
  it('reads the recent past in units a person uses', () => {
    expect(ago('2026-08-16T11:59:30Z', now)).toBe('just now');
    expect(ago('2026-08-16T11:30:00Z', now)).toBe('30m ago');
    expect(ago('2026-08-16T08:00:00Z', now)).toBe('4h ago');
    expect(ago('2026-08-14T12:00:00Z', now)).toBe('2d ago');
  });

  it('does not say something happened in the future when clocks disagree', () => {
    expect(ago('2026-08-16T12:00:04Z', now)).toBe('just now');
  });

  it('says nothing for a timestamp it cannot read', () => {
    expect(ago('', now)).toBe('');
  });
});

describe('scoping to one project', () => {
  const branches = [{ id: 'b1', treeId: 't1' }, { id: 'b2', treeId: 't2' }, { id: 'b3' }];

  it('keeps only that tree\'s conversations and their work', () => {
    const out = scopeToTree('t1', branches, [
      leaf({ id: 'mine', branchId: 'b1' }),
      leaf({ id: 'theirs', branchId: 'b2' }),
      leaf({ id: 'unfiled', branchId: 'b3' }),
    ]);
    expect(out.branches.map((b) => b.id)).toEqual(['b1']);
    expect(out.leaves.map((l) => l.id)).toEqual(['mine']);
  });

  it('excludes unfiled conversations rather than adopting them', () => {
    expect(scopeToTree('t1', branches, [leaf({ branchId: 'b3' })]).leaves).toEqual([]);
  });
});

describe('grouping a project\'s work', () => {
  it('puts what is owed above what is done', () => {
    const out = groupWork([
      leaf({ id: 'v', status: 'succeeded', verified: true }),
      leaf({ id: 'f', status: 'failed' }),
      leaf({ id: 'c', status: 'succeeded', verified: false }),
      leaf({ id: 'r', status: 'running' }),
    ]);
    expect(out.map((g) => g.state)).toEqual(['failed', 'running', 'claimed', 'verified']);
  });

  it('omits groups with nothing in them', () => {
    const out = groupWork([leaf({ status: 'succeeded', verified: true })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.state).toBe('verified');
  });

  it('leaves cancelled work out entirely', () => {
    expect(groupWork([leaf({ status: 'cancelled' })])).toEqual([]);
  });
});

describe('a run that is over', () => {
  const branches = [{ id: 'b1', title: 'Last night\'s run' }, { id: 'b2', title: 'Live run' }];

  it('is settled when nothing on it can move by itself', () => {
    const settled = settledBranches(branches, [
      leaf({ branchId: 'b1', status: 'succeeded' }),
      leaf({ branchId: 'b1', status: 'failed' }),
      leaf({ branchId: 'b2', status: 'running' }),
    ]);
    expect([...settled]).toEqual(['b1']);
  });

  it('is not settled while a proposal awaits a decision', () => {
    expect([...settledBranches(branches, [leaf({ branchId: 'b1', status: 'proposed' })])]).toEqual([]);
  });

  it('does not call an empty conversation finished', () => {
    expect([...settledBranches(branches, [])]).toEqual([]);
  });

  it('moves its failures out of the urgent list', () => {
    const leaves = [
      leaf({ id: 'old', branchId: 'b1', status: 'failed' }),
      leaf({ id: 'new', branchId: 'b2', status: 'failed' }),
      leaf({ id: 'live', branchId: 'b2', status: 'running' }),
    ];
    const settled = settledBranches(branches, leaves);
    expect(needsYou(leaves, settled).map((a) => a.leaf.id)).toEqual(['new']);
    expect(outstandingWork(branches, leaves).map((o) => o.leaf.id)).toEqual(['old']);
  });

  it('says which run the outstanding work came from', () => {
    const leaves = [leaf({ id: 'old', branchId: 'b1', status: 'failed',
      attempts: [{ attempt: 0, error: 'e', failedAt: '' }, { attempt: 1, error: 'e', failedAt: '' }] })];
    const [out] = outstandingWork(branches, leaves);
    expect(out!.from).toBe("Last night's run");
    expect(out!.attempts).toBe(2);
  });

  it('leaves cancelled work alone', () => {
    const leaves = [leaf({ branchId: 'b1', status: 'cancelled' })];
    expect(outstandingWork(branches, leaves)).toEqual([]);
  });

  it('does not treat a failure from a still-running conversation as settled', () => {
    const leaves = [
      leaf({ id: 'f', branchId: 'b2', status: 'failed' }),
      leaf({ id: 'r', branchId: 'b2', status: 'running' }),
    ];
    expect(outstandingWork(branches, leaves)).toEqual([]);
  });
});
