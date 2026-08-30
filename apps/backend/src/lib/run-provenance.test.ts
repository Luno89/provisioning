import { describe, it, expect } from 'vitest';
import { ranAs } from './run-provenance.js';
import { PACK_SEEDS } from './pack-seeds.js';

// Deep-cloned: PACK_SEEDS is a live module array, and a test that mutates a pack would otherwise
// retune every later test in the file.
const pack = () => structuredClone({
  id: 'pack-koala', slug: 'koala', name: 'Koala', personaId: 'p1', tools: [],
  sampling: PACK_SEEDS[0]!.sampling, budget: PACK_SEEDS[0]!.budget, prompt: PACK_SEEDS[0]!.prompt,
  overrides: {}, createdAt: '', updatedAt: '2026-08-30T00:00:00.000Z',
});

/**
 * A run record has to say what it ran under. This project has twice been bitten by a variant named
 * after a configuration it was not running, and once the layering is gone there is no resolver left
 * to attribute a value to a source — so the pack's values are copied into the record at run time.
 */
describe('what a finished run can say about how it was configured', () => {
  it('names the pack, so a result is attributable at all', () => {
    const out = ranAs(pack())!;
    expect(out.packId).toBe('pack-koala');
    expect(out.slug).toBe('koala');
  });

  it('copies the values rather than pointing at a row that can be edited later', () => {
    const p = pack();
    const out = ranAs(p)!;
    p.budget.rounds = 99;

    expect(out.budget.rounds).toBe(PACK_SEEDS[0]!.budget.rounds);
    expect(out.budget.rounds).not.toBe(99);
  });

  it('records when the pack was last edited, so two runs of one slug are distinguishable', () => {
    expect(ranAs(pack())!.packUpdatedAt).toBe('2026-08-30T00:00:00.000Z');
  });

  it('carries the sampler, which is what a comparison between two runs turns on', () => {
    expect(ranAs(pack())!.sampling).toEqual(PACK_SEEDS[0]!.sampling);
  });

  it('says nothing at all for a run with no pack, rather than inventing a default', () => {
    expect(ranAs(null)).toBeUndefined();
    expect(ranAs(undefined)).toBeUndefined();
  });
});
