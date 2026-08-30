import { describe, it, expect } from 'vitest';
import { deriveVariantPack, isDerived, visibleToUser, foldPromotion, editFromKnobs, validatePackValues } from './derived-packs.js';
import { PACK_SEEDS } from './pack-seeds.js';
import type { PersonaPack } from '@koala/harness-types';

const base = (): PersonaPack => structuredClone({
  id: 'pack-koala', slug: 'koala', name: 'Koala', personaId: 'p1', tools: ['get_logs'],
  sampling: PACK_SEEDS[0]!.sampling, budget: PACK_SEEDS[0]!.budget, prompt: PACK_SEEDS[0]!.prompt,
  createdAt: '', updatedAt: '2026-08-30T00:00:00.000Z',
} as PersonaPack);

/**
 * A Lab arm varies a pack, not a bag of overrides. Arms therefore need a pack each — but a user
 * does not want ten versions of Koala in their pack list, so an arm's pack is scoped to its
 * experiment and hidden, and promotion folds the winner back into the pack it came from.
 */
describe('the pack an experiment arm runs as', () => {
  it('is a copy of the base pack, with the arm\'s values applied', () => {
    const arm = deriveVariantPack(base(), 'exp-1', 'hot', {
      sampling: { toolTurn: { temperature: 0.9 } },
    }, 'now');

    expect(arm.sampling.toolTurn.temperature).toBe(0.9);
    expect(arm.budget.rounds).toBe(base().budget.rounds);
    expect(arm.tools).toEqual(['get_logs']);
  });

  it('does not touch the pack it was derived from', () => {
    const original = base();
    deriveVariantPack(original, 'exp-1', 'hot', { sampling: { toolTurn: { temperature: 0.9 } } }, 'now');
    expect(original.sampling.toolTurn.temperature).toBe(PACK_SEEDS[0]!.sampling.toolTurn.temperature);
  });

  it('remembers what it came from, which is what promotion writes back to', () => {
    const arm = deriveVariantPack(base(), 'exp-1', 'hot', {}, 'now');
    expect(arm.derivedFrom).toEqual({ packId: 'pack-koala', experimentId: 'exp-1', label: 'hot' });
    expect(isDerived(arm)).toBe(true);
    expect(isDerived(base())).toBe(false);
  });

  it('is stable across re-derivation, so editing an arm does not orphan its runs', () => {
    const first = deriveVariantPack(base(), 'exp-1', 'hot', {}, 'now');
    const again = deriveVariantPack(base(), 'exp-1', 'hot', {}, 'later');
    expect(again.id).toBe(first.id);
  });

  it('stays out of the pack list, so a user never sees ten versions of Koala', () => {
    const arm = deriveVariantPack(base(), 'exp-1', 'hot', {}, 'now');
    expect(visibleToUser([base(), arm]).map((p) => p.id)).toEqual(['pack-koala']);
  });
});

describe('promoting an arm', () => {
  const arm = () => deriveVariantPack(base(), 'exp-1', 'hot', {
    sampling: { toolTurn: { temperature: 0.9 } },
    budget: { rounds: 12 },
  }, 'now');

  it('overwrites the pack it was based on rather than adding another one', () => {
    const { pack } = foldPromotion(base(), arm(), 'later')!;

    expect(pack.id).toBe('pack-koala');
    expect(pack.slug).toBe('koala');
    expect(pack.sampling.toolTurn.temperature).toBe(0.9);
    expect(pack.budget.rounds).toBe(12);
    expect(pack.derivedFrom).toBeUndefined();
  });

  it('reports what would change, so the user can be asked before it happens', () => {
    const { changes } = foldPromotion(base(), arm(), 'later')!;

    expect(changes).toContainEqual({ path: 'sampling.toolTurn.temperature', from: 0.3, to: 0.9 });
    expect(changes).toContainEqual({ path: 'budget.rounds', from: 8, to: 12 });
    expect(changes.map((c) => c.path)).not.toContain('tools');
  });

  it('reports no change when the arm never differed from its base', () => {
    const untouched = deriveVariantPack(base(), 'exp-1', 'control', {}, 'now');
    expect(foldPromotion(base(), untouched, 'later')!.changes).toEqual([]);
  });

  it('refuses an arm that did not come from that pack', () => {
    const other = { ...base(), id: 'pack-other' };
    expect(foldPromotion(other, arm(), 'later')).toBeNull();
  });
});

describe('turning a knob into a pack edit', () => {
  it('writes at the path the tunable declares, not at its key', () => {
    expect(editFromKnobs({ temperature: 0.9 })).toEqual({
      sampling: { toolTurn: { temperature: 0.9 } },
    });
  });

  it('merges two knobs that share a branch', () => {
    expect(editFromKnobs({ temperature: 0.9, top_p: 0.8 })).toEqual({
      sampling: { toolTurn: { temperature: 0.9, top_p: 0.8 } },
    });
  });

  it('keeps knobs that live in different parts of the pack apart', () => {
    expect(editFromKnobs({ temperature: 0.9, maxSteps: 40 })).toEqual({
      sampling: { toolTurn: { temperature: 0.9 } },
      budget: { run: { steps: 40 } },
    });
  });

  it('ignores a knob with no pack field, rather than inventing one', () => {
    expect(editFromKnobs({ think: true })).toEqual({});
  });
});

describe('refusing a pack value that would break a run', () => {
  const withTemp = (t: unknown) => ({
    ...base(),
    sampling: { toolTurn: { temperature: t as number }, conversation: {} },
  });

  it('refuses a value outside the range its knob declares', () => {
    expect(validatePackValues(withTemp(5))).toMatch(/temperature/i);
    expect(validatePackValues(withTemp(-1))).toMatch(/temperature/i);
  });

  it('accepts a value inside it', () => {
    expect(validatePackValues(withTemp(0.9))).toBeNull();
  });

  it('accepts an engine parameter the table does not model, since engines have their own', () => {
    // Unknown keys used to be refused as "unknown setting" when they arrived as overrides. A pack's
    // sampler legitimately carries parameters this table has never heard of, so they pass through.
    expect(validatePackValues({
      ...base(),
      sampling: { toolTurn: { some_engine_knob: 1 }, conversation: {} },
    })).toBeNull();
  });

  it('refuses a budget outside its range too, not just a sampler value', () => {
    expect(validatePackValues({ ...base(), budget: { ...base().budget, run: { ...base().budget.run, steps: -5 } } }))
      .toMatch(/max steps/i);
  });
});
