import { describe, it, expect } from 'vitest';
import { statsFor, median, byLineage } from './persona-stats.js';
import type { Leaf } from './leaf-types.js';

/**
 * Whether a persona is any good, measured rather than asserted.
 *
 * Each test below is aimed at a way the number could be *plausibly wrong* rather than at the line
 * that computes it — a rate that quietly counts unfinished work, a median that a single outlier
 * moves, a lineage that loses a persona when its parent is deleted. Those are the failures that
 * would ship looking right.
 */

const leaf = (over: Partial<Leaf>): Leaf => ({
  id: Math.random().toString(36).slice(2), branchId: 'b', title: 't',
  status: 'succeeded', depth: 0, blocking: true, childCount: 0, updatedAt: '', ...over,
} as Leaf);

describe('how a persona has actually done', () => {
  it('rates verification over finished work, not everything assigned', () => {
    /**
     * The failure this prevents: queueing ten leaves to a persona would drop its score to near zero
     * before any of them ran, so the number would measure how busy it is rather than how well it
     * does its job.
     */
    const leaves = [
      leaf({ personaId: 'p', status: 'succeeded', verified: true }),
      leaf({ personaId: 'p', status: 'failed' }),
      leaf({ personaId: 'p', status: 'running' }),
      leaf({ personaId: 'p', status: 'proposed' }),
      leaf({ personaId: 'p', status: 'pending' }),
    ];
    const s = statsFor('p', leaves);
    expect(s.assigned).toBe(5);
    expect(s.finished).toBe(2);
    expect(s.verifiedRate).toBe(0.5);
  });

  it('does not count a claim as a verification', () => {
    // The distinction the whole board exists to preserve. A rate built on `succeeded` measures the
    // agent's opinion of itself.
    const leaves = [
      leaf({ personaId: 'p', status: 'succeeded', verified: false }),
      leaf({ personaId: 'p', status: 'succeeded', verified: false }),
    ];
    expect(statsFor('p', leaves).verifiedRate).toBe(0);
  });

  it('says nothing rather than zero when nothing has finished', () => {
    // "0%" accuses a persona that has never had the chance to fail.
    const s = statsFor('p', [leaf({ personaId: 'p', status: 'running' })]);
    expect(s.verifiedRate).toBeUndefined();
    expect(s.assigned).toBe(1);
  });

  it('ignores other personas entirely', () => {
    const leaves = [leaf({ personaId: 'other', status: 'succeeded', verified: true })];
    expect(statsFor('p', leaves).assigned).toBe(0);
  });

  it('takes a median so one runaway run does not redefine the cost', () => {
    /**
     * Measured on this instance: Builder's runs ranged 43k to 604k tokens. The mean of those is a
     * number no run ever cost, and it is the number a person would budget against.
     */
    const leaves = [43_000, 97_000, 103_000, 604_000].map((t) =>
      leaf({ personaId: 'p', usage: { tokens: t } }));
    expect(statsFor('p', leaves).medianTokens).toBe(100_000);
    // The mean would be 211,750 — nearly nothing like a typical run.
    expect(statsFor('p', leaves).medianTokens).toBeLessThan(150_000);
  });

  it('leaves runs that recorded no usage out of the median', () => {
    // A leaf that never ran has 0 tokens, and letting those into the sample drags the typical cost
    // toward zero the more work is queued.
    const leaves = [
      leaf({ personaId: 'p', usage: { tokens: 100_000 } }),
      leaf({ personaId: 'p', status: 'proposed' }),
      leaf({ personaId: 'p', status: 'proposed' }),
    ];
    expect(statsFor('p', leaves).medianTokens).toBe(100_000);
  });

  it('counts a retry from the attempt array, which is sometimes a number', () => {
    // `attempts` is an array on a leaf record and a count on a board payload — reading .length off
    // the number is silent and would report zero retries forever.
    const leaves = [
      leaf({ personaId: 'p', attempts: [{ attempt: 0, error: 'x', failedAt: '' }, { attempt: 1, error: 'y', failedAt: '' }] }),
      leaf({ personaId: 'p', attempts: [{ attempt: 0, error: 'x', failedAt: '' }] }),
    ];
    expect(statsFor('p', leaves).retried).toBe(1);
  });
});

describe('median', () => {
  it('averages the two middles on an even count', () => {
    expect(median([1, 3])).toBe(2);
  });
  it('is zero for nothing, rather than NaN', () => {
    // NaN renders as "NaN tokens" on a card, which reads as a bug in the harness.
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
    /**
     * The one that would lose data. Treating "has a basedOn" as "is a variant" drops any persona
     * whose parent is gone from the list entirely — and it still runs work.
     */
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
