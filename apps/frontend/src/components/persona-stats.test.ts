import { describe, it, expect } from 'vitest';
import { statsFor, median, byLineage } from './persona-stats.js';
import type { Leaf } from './leaf-types.js';

const leaf = (over: Partial<Leaf>): Leaf => ({
  id: Math.random().toString(36).slice(2), branchId: 'b', title: 't',
  status: 'succeeded', depth: 0, blocking: true, childCount: 0, updatedAt: '', ...over,
} as Leaf);

describe('how a persona has actually done', () => {
  it('rates verification over finished work, not everything assigned', () => {
    const leaves = [
      leaf({ packId: 'p', status: 'succeeded', verified: true }),
      leaf({ packId: 'p', status: 'failed' }),
      leaf({ packId: 'p', status: 'running' }),
      leaf({ packId: 'p', status: 'proposed' }),
      leaf({ packId: 'p', status: 'pending' }),
    ];
    const s = statsFor('p', leaves);
    expect(s.assigned).toBe(5);
    expect(s.finished).toBe(2);
    expect(s.verifiedRate).toBe(0.5);
  });

  it('does not count a claim as a verification', () => {
    const leaves = [
      leaf({ packId: 'p', status: 'succeeded', verified: false }),
      leaf({ packId: 'p', status: 'succeeded', verified: false }),
    ];
    expect(statsFor('p', leaves).verifiedRate).toBe(0);
  });

  it('says nothing rather than zero when nothing has finished', () => {
    const s = statsFor('p', [leaf({ packId: 'p', status: 'running' })]);
    expect(s.verifiedRate).toBeUndefined();
    expect(s.assigned).toBe(1);
  });

  it('ignores other personas entirely', () => {
    const leaves = [leaf({ packId: 'other', status: 'succeeded', verified: true })];
    expect(statsFor('p', leaves).assigned).toBe(0);
  });

  it('takes a median so one runaway run does not redefine the cost', () => {
    const leaves = [43_000, 97_000, 103_000, 604_000].map((t) =>
      leaf({ packId: 'p', usage: { tokens: t } }));
    expect(statsFor('p', leaves).medianTokens).toBe(100_000);
    expect(statsFor('p', leaves).medianTokens).toBeLessThan(150_000);
  });

  it('leaves runs that recorded no usage out of the median', () => {
    const leaves = [
      leaf({ packId: 'p', usage: { tokens: 100_000 } }),
      leaf({ packId: 'p', status: 'proposed' }),
      leaf({ packId: 'p', status: 'proposed' }),
    ];
    expect(statsFor('p', leaves).medianTokens).toBe(100_000);
  });

  it('counts a retry from the attempt array, which is sometimes a number', () => {
    const leaves = [
      leaf({ packId: 'p', attempts: [{ attempt: 0, error: 'x', failedAt: '' }, { attempt: 1, error: 'y', failedAt: '' }] }),
      leaf({ packId: 'p', attempts: [{ attempt: 0, error: 'x', failedAt: '' }] }),
    ];
    expect(statsFor('p', leaves).retried).toBe(1);
  });
});

describe('median', () => {
  it('averages the two middles on an even count', () => {
    expect(median([1, 3])).toBe(2);
  });
  it('is zero for nothing, rather than NaN', () => {
    expect(median([])).toBe(0);
  });
});

describe('grouping personas by what they came from', () => {
  const p = (id: string, basedOn?: string) => ({ id, name: id, ...(basedOn ? { basedOn } : {}) });

  it('puts variants under the persona they were forked from', () => {
    const groups = byLineage([p('researcher'), p('short', 'researcher'), p('kept', 'researcher'), p('builder')]);
    expect(groups.map((g) => g.root.id)).toEqual(['researcher', 'builder']);
    expect(groups[0]!.variants.map((v) => v.id)).toEqual(['short', 'kept']);
  });

  it('keeps a persona whose parent was deleted', () => {
    const groups = byLineage([p('orphan', 'deleted-id')]);
    expect(groups.map((g) => g.root.id)).toEqual(['orphan']);
  });

  it('lists every persona exactly once', () => {
    const all = [p('a'), p('b', 'a'), p('c', 'a'), p('d'), p('e', 'gone')];
    const groups = byLineage(all);
    const seen = groups.flatMap((g) => [g.root.id, ...g.variants.map((v) => v.id)]);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
