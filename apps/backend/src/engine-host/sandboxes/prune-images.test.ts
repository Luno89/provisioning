import { describe, it, expect, vi } from 'vitest';
import { createImagePruner, PRUNE_GRACE_MS, type RegistryImageTag } from './prune-images.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const aged = (ms: number) => new Date(NOW - ms).toISOString();

function setup(over: {
  tags?: RegistryImageTag[];
  wanted?: { fingerprint: string; who: string }[];
  graceMs?: number;
  refuses?: string[];
} = {}) {
  const removed: string[] = [];
  const pruner = createImagePruner({
    tags: async () => over.tags ?? [],
    wanted: async () => over.wanted ?? [],
    remove: vi.fn(async (fingerprint: string) => {
      if ((over.refuses ?? []).includes(fingerprint)) throw new Error('the registry refused');
      removed.push(fingerprint);
    }),
    now: () => NOW,
    ...(over.graceMs === undefined ? {} : { graceMs: over.graceMs }),
  });

  return { pruner, removed };
}

describe('letting go of the images nothing would run', () => {
  it('keeps every image something still plans', async () => {
    const { pruner, removed } = setup({
      tags: [{ fingerprint: 'wanted-one', createdAt: aged(40 * DAY) }],
      wanted: [{ fingerprint: 'wanted-one', who: 'executor' }],
    });

    const report = await pruner.prune();

    expect(report.kept).toEqual(['wanted-one']);
    expect(report.removed).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('lets go of an image nothing plans, once it is past the grace window', async () => {
    const { pruner } = setup({
      tags: [
        { fingerprint: 'stale', createdAt: aged(PRUNE_GRACE_MS + DAY) },
        { fingerprint: 'wanted-one', createdAt: aged(40 * DAY) },
      ],
      wanted: [{ fingerprint: 'wanted-one', who: 'executor' }],
    });

    const report = await pruner.prune();

    expect(report.removed).toEqual(['stale']);
    expect(report.kept).toEqual(['wanted-one']);
  });

  it('leaves a young image alone, because a build publishes before anything plans it again', async () => {
    const { pruner, removed } = setup({
      tags: [{ fingerprint: 'fresh', createdAt: aged(60_000) }],
    });

    const report = await pruner.prune();

    expect(report.tooNew).toEqual(['fresh']);
    expect(removed).toEqual([]);
  });

  it('keeps an image whose date it cannot read, since keeping is cheap and rebuilding is not', async () => {
    const { pruner, removed } = setup({
      tags: [{ fingerprint: 'undated', createdAt: 'not a date' }],
    });

    const report = await pruner.prune();

    expect(report.tooNew).toEqual(['undated']);
    expect(removed).toEqual([]);
  });

  it('carries on past a deletion the registry refuses, and says which one', async () => {
    const { pruner, removed } = setup({
      tags: [
        { fingerprint: 'refused', createdAt: aged(40 * DAY) },
        { fingerprint: 'stale', createdAt: aged(40 * DAY) },
      ],
      refuses: ['refused'],
    });

    const report = await pruner.prune();

    expect(report.failed).toEqual([{ fingerprint: 'refused', detail: 'the registry refused' }]);
    expect(removed).toEqual(['stale']);
  });

  it('takes the grace window it is given', async () => {
    const { pruner } = setup({
      tags: [{ fingerprint: 'an-hour-old', createdAt: aged(60 * 60_000) }],
      graceMs: 60_000,
    });

    expect((await pruner.prune()).removed).toEqual(['an-hour-old']);
  });
});
