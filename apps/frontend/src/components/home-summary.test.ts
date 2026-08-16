import { describe, it, expect } from 'vitest';
import { needsYou, running, changedSince, treeRollups, ago, scopeToTree, groupWork } from './home-summary.js';
import type { Leaf } from './leaf-types.js';

/**
 * The landing page's arithmetic.
 *
 * A summary is read fastest and questioned least, so a wrong number here survives longest. Each of
 * these aims at a way the figure could be plausibly wrong rather than at the line that computes it.
 */

const leaf = (over: Partial<Leaf>): Leaf => ({
  id: 'l', branchId: 'b1', title: 't', status: 'succeeded',
  depth: 0, blocking: true, childCount: 0, updatedAt: '2026-08-01T00:00:00Z', ...over,
} as Leaf);

describe('what needs you', () => {
  it('puts work already spent ahead of a decision not yet made', () => {
    /**
     * A failure is owed — tokens went out and nothing came back. A proposal has cost nothing yet.
     * Ordering proposals first would put the cheap decision above the expensive problem.
     */
    const out = needsYou([
      leaf({ id: 'p', status: 'proposed' }),
      leaf({ id: 'f', status: 'failed' }),
    ]);
    expect(out.map((a) => a.leaf.id)).toEqual(['f', 'p']);
  });

  it('puts the most-attempted failure first', () => {
    // A leaf on its third attempt is the one least likely to fix itself, and the one where another
    // retry is most likely to be the wrong instinct.
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
    // The board payload spells it as a number; sorting must not throw on it.
    const odd = { ...leaf({ id: 'x', status: 'failed' }), attempts: 3 } as unknown as Leaf;
    expect(() => needsYou([odd])).not.toThrow();
    expect(needsYou([odd])).toHaveLength(1);
  });
});

describe('what is running', () => {
  it('is only work actually in a sandbox', () => {
    /**
     * `pending` means accepted and waiting its turn, which looks like progress and is not. Showing
     * it here would have the page claim Koala is working when nothing has started.
     */
    const out = running([
      leaf({ id: 'live', status: 'running' }),
      leaf({ id: 'queued', status: 'pending' }),
      leaf({ id: 'proposed', status: 'proposed' }),
      leaf({ id: 'done', status: 'succeeded' }),
    ]);
    expect(out.map((l) => l.id)).toEqual(['live']);
  });

  it('is empty rather than undefined when nothing runs', () => {
    // The page maps over this directly; undefined would blank the whole section.
    expect(running([])).toEqual([]);
  });
});

describe('what changed while you were away', () => {
  it('excludes work that is still running', () => {
    /**
     * Running leaves have their own list. Counting them in both makes a quiet night read as a busy
     * one, which is the exact thing this page exists to report accurately.
     */
    const out = changedSince([
      leaf({ id: 'done', updatedAt: '2026-08-02T00:00:00Z' }),
      leaf({ id: 'live', status: 'running', updatedAt: '2026-08-02T00:00:00Z' }),
    ], '2026-08-01T00:00:00Z');
    expect(out.map((l) => l.id)).toEqual(['done']);
  });

  it('shows nothing rather than everything when there is no last-looked time', () => {
    // First visit. "Everything changed since never" would be a wall of every leaf ever run.
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
    // The most damaging place to flatten these, because a summary is scanned rather than read.
    const r = treeRollups(trees, branches, [
      leaf({ id: '1', branchId: 'b1', status: 'succeeded', verified: true }),
      leaf({ id: '2', branchId: 'b1', status: 'succeeded', verified: false }),
    ])[0]!;
    expect(r.verified).toBe(1);
    expect(r.claimed).toBe(1);
  });

  it('counts a failure as still outstanding', () => {
    // A failed leaf is not finished — it is owed. Counting it as done would show a broken tree at
    // 100%.
    const r = treeRollups(trees, branches, [
      leaf({ id: '1', branchId: 'b1', status: 'succeeded', verified: true }),
      leaf({ id: '2', branchId: 'b1', status: 'failed' }),
    ])[0]!;
    expect(r.failed).toBe(1);
    expect(r.outstanding).toBe(1);
  });

  it('ignores cancelled work rather than counting it as left to do', () => {
    /**
     * Cancelled is neither done nor owed. Including it would leave a tree permanently short of
     * complete for work somebody deliberately stopped.
     */
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
    // A new tree must appear so you can start work in it, not vanish until it has output.
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
    /**
     * The server writes the timestamp and the browser reads it; a few seconds of skew is normal
     * and "in 4 seconds ago" reads as a broken harness.
     */
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
    // A conversation filed under nothing belongs to no project; sweeping it into whichever tree is
    // open would attribute work to a project that never asked for it.
    expect(scopeToTree('t1', branches, [leaf({ branchId: 'b3' })]).leaves).toEqual([]);
  });
});

describe('grouping a project\'s work', () => {
  it('puts what is owed above what is done', () => {
    /**
     * The order is the argument: descending "should you do something about this". A board sorted by
     * state alphabetically, or by creation, buries the failures under twenty green rows.
     */
    const out = groupWork([
      leaf({ id: 'v', status: 'succeeded', verified: true }),
      leaf({ id: 'f', status: 'failed' }),
      leaf({ id: 'c', status: 'succeeded', verified: false }),
      leaf({ id: 'r', status: 'running' }),
    ]);
    expect(out.map((g) => g.state)).toEqual(['failed', 'running', 'claimed', 'verified']);
  });

  it('omits groups with nothing in them', () => {
    // Five empty columns was the board's normal state and 83% of its width.
    const out = groupWork([leaf({ status: 'succeeded', verified: true })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.state).toBe('verified');
  });

  it('leaves cancelled work out entirely', () => {
    expect(groupWork([leaf({ status: 'cancelled' })])).toEqual([]);
  });
});
