import { describe, it, expect } from 'vitest';
import {
  standingOf,
  buildPromotion,
  supersede,
  revertTo,
  MAX_PROFILE_HISTORY,
  type HarnessProfile,
} from './harness-profile.js';
import type { Experiment, VariantResult } from './experiments.js';
import { deriveVariantPack } from './derived-packs.js';
import { PACK_SEEDS } from './pack-seeds.js';
import type { PersonaPack } from '@koala/harness-types';

const run = (label: string, taskId: string, verified: boolean, over: Partial<VariantResult> = {}): VariantResult => ({
  label,
  taskId,
  succeeded: verified,
  verified,
  verifyExitCode: verified ? 0 : 1,
  verifyOutput: '',
  steps: 5,
  tokensUsed: 1000,
  durationMs: 1000,
  summary: '',
  transcript: [],
  ...over,
});

const experiment = (over: Partial<Experiment> = {}): Experiment => ({
  id: 'e1',
  ownerId: 'u1',
  name: 'reasoning on dispatch turns',
  tasks: [
    { id: 't1', name: 'fib', prompt: 'a', verifyCommand: 'node t.js' },
    { id: 't2', name: 'csv', prompt: 'b', verifyCommand: 'node t.js' },
  ],
  language: 'node',
  variants: [
    { label: 'think=false', packId: 'exp:e1:think=false' },
    { label: 'think=true', packId: 'exp:e1:think=true' },
  ],
  repeats: 1,
  status: 'complete',
  results: [],
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
  ...over,
});

describe('standingOf', () => {
  it('reports a variant that won outright', () => {
    const e = experiment({ results: [
      run('think=false', 't1', true), run('think=false', 't2', true),
      run('think=true', 't1', false), run('think=true', 't2', false),
    ] });

    const standing = standingOf(e, 'think=false')!;
    expect(standing.verified).toBe(2);
    expect(standing.runs).toBe(2);
    expect(standing.tasks).toBe(2);
    expect(standing.rank).toBe(1);
    expect(standing.wasBest).toBe(true);
    expect(standing.behindBy).toBe(0);
  });

  it('reports how far behind a losing variant is, rather than hiding it', () => {
    const e = experiment({ results: [
      run('think=false', 't1', true), run('think=false', 't2', true),
      run('think=true', 't1', true), run('think=true', 't2', false),
    ] });

    const standing = standingOf(e, 'think=true')!;
    expect(standing.rank).toBe(2);
    expect(standing.wasBest).toBe(false);
    expect(standing.behindBy).toBe(0.5);
  });

  it('ranks by rate, not count, so an errored run cannot flatter a variant', () => {
    const e = experiment({ results: [
      run('think=false', 't1', true), run('think=false', 't2', false),
      run('think=true', 't1', true),
    ] });

    expect(standingOf(e, 'think=true')!.rank).toBe(1);
    expect(standingOf(e, 'think=false')!.rank).toBe(2);
  });

  it('marks a tie as best for both, since neither lost', () => {
    const e = experiment({ results: [
      run('think=false', 't1', true), run('think=true', 't1', true),
    ] });
    expect(standingOf(e, 'think=false')!.wasBest).toBe(true);
    expect(standingOf(e, 'think=true')!.wasBest).toBe(true);
  });

  it('returns nothing for a variant with no results', () => {
    expect(standingOf(experiment(), 'think=false')).toBeNull();
  });
});

describe('profile history', () => {
  const now = '2026-08-04T12:00:00.000Z';
  const inForce: HarnessProfile = {
    ownerId: 'u1',
    packId: 'pack-a',
    from: {
      experimentId: 'e1', experimentName: 'first', variantLabel: 'think=true',
      verified: 2, runs: 2, tasks: 2, wasBest: true, promotedAt: '2026-08-01T00:00:00.000Z',
    },
    updatedAt: '2026-08-01T00:00:00.000Z',
  };

  it('files the outgoing pack instead of overwriting it', () => {
    const next = supersede(inForce, { ownerId: 'u1', packId: 'pack-b', updatedAt: '' }, now);

    expect(next.packId).toBe('pack-b');
    expect(next.history).toHaveLength(1);
    expect(next.history![0]!.packId).toBe('pack-a');
    expect(next.history![0]!.from!.experimentName).toBe('first');
    expect(next.history![0]!.supersededAt).toBe(now);
  });

  it('files nothing when there was nothing in force', () => {
    expect(supersede(null, { ownerId: 'u1', updatedAt: '' }, now).history)
      .toBeUndefined();
  });

  it('restores the pack that was superseded', () => {
    const second = supersede(inForce, { ownerId: 'u1', packId: 'pack-b', updatedAt: '' }, now);
    const back = revertTo(second, second.history![0]!.id, now)!;

    expect(back.packId).toBe('pack-a');
    expect(back.history!.map((v) => v.packId)).toEqual(['pack-a', 'pack-b']);
  });

  it('returns nothing for a version that does not exist', () => {
    expect(revertTo(inForce, 'nope')).toBeNull();
  });

  it('keeps history bounded, dropping the oldest first', () => {
    let p: HarnessProfile = inForce;
    for (let i = 0; i < MAX_PROFILE_HISTORY + 5; i++) {
      p = supersede(p, { ownerId: 'u1', packId: `pack-${i}`, updatedAt: '' }, now);
    }
    expect(p.history).toHaveLength(MAX_PROFILE_HISTORY);
    expect(p.history![p.history!.length - 1]!.packId).toBe(`pack-${MAX_PROFILE_HISTORY + 3}`);
  });
});


describe('promoting an arm into the pack it came from', () => {
  const won = experiment({ results: [
    run('think=true', 't1', true), run('think=true', 't2', true),
    run('think=false', 't1', false), run('think=false', 't2', false),
  ] });
  const koala = (): PersonaPack => structuredClone({
    id: 'pack-koala', slug: 'koala', name: 'Koala', personaId: 'p1', tools: [],
    sampling: PACK_SEEDS[0]!.sampling, budget: PACK_SEEDS[0]!.budget, prompt: PACK_SEEDS[0]!.prompt,
    createdAt: '', updatedAt: '',
  } as PersonaPack);
  const arms = () => [
    koala(),
    deriveVariantPack(koala(), 'e1', 'think=true', { budget: { rounds: 12 } }, 'now'),
    deriveVariantPack(koala(), 'e1', 'think=false', {}, 'now'),
  ];

  it('overwrites the pack the arm was derived from, keeping its identity', () => {
    const built = buildPromotion(won, 'think=true', arms(), '2026-08-04T12:00:00.000Z')!;

    expect(built.pack.id).toBe('pack-koala');
    expect(built.pack.slug).toBe('koala');
    expect(built.pack.budget.rounds).toBe(12);
    expect(built.target.id).toBe('pack-koala');
  });

  it('says what would change, so the user can be asked before it happens', () => {
    const built = buildPromotion(won, 'think=true', arms(), 'now')!;
    expect(built.changes).toEqual([{ path: 'budget.rounds', from: 8, to: 12 }]);
  });

  it('records the evidence, so a promoted value can explain itself later', () => {
    const built = buildPromotion(won, 'think=true', arms(), 'now')!;
    expect(built.standing.verified).toBe(2);
    expect(built.standing.wasBest).toBe(true);
  });

  it('allows promoting an arm that did not win, but says so', () => {
    expect(buildPromotion(won, 'think=false', arms(), 'now')!.standing.wasBest).toBe(false);
  });

  it('returns nothing for an arm the experiment does not have', () => {
    expect(buildPromotion(won, 'nope', arms(), 'now')).toBeNull();
  });
});
