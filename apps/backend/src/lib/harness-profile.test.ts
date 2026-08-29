import { describe, it, expect } from 'vitest';
import {
  standingOf,
  promotedOverrides,
  diffOverrides,
  buildPromotion,
  effectiveOverrides,
  supersede,
  revertTo,
  MAX_PROFILE_HISTORY,
  withOverrides,
  type HarnessProfile,
} from './harness-profile.js';
import type { Experiment, VariantResult } from './experiments.js';

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
    { label: 'think=false', overrides: { think: false } },
    { label: 'think=true', overrides: { think: true } },
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

describe('promotedOverrides', () => {
  it('folds the variant onto the profile it ran against', () => {
    expect(promotedOverrides({ temperature: 0.2, think: false }, { think: true }))
      .toEqual({ temperature: 0.2, think: true });
  });

  it('leaves language out, since it picks an image rather than a call parameter', () => {
    expect(promotedOverrides({}, { think: true, language: 'go' })).toEqual({ think: true });
  });
});

describe('diffOverrides', () => {
  it('says what promoting would actually change, by label', () => {
    const changes = diffOverrides({ temperature: 0.3 }, { temperature: 0.7, think: true });
    expect(changes).toEqual([
      { key: 'temperature', label: 'Temperature', from: 0.3, to: 0.7 },
      { key: 'think', label: 'Reasoning on dispatch turns', from: undefined, to: true },
    ]);
  });

  it('reports nothing when a promotion changes nothing', () => {
    expect(diffOverrides({ think: true }, { think: true })).toEqual([]);
  });
});

describe('buildPromotion', () => {
  const won = experiment({ results: [
    run('think=true', 't1', true), run('think=true', 't2', true),
    run('think=false', 't1', false), run('think=false', 't2', false),
  ] });

  it('records the evidence with the values, so a default can explain itself later', () => {
    const built = buildPromotion(won, 'think=true', null, 'u1', '2026-08-04T12:00:00.000Z')!;

    expect(built.profile.overrides).toEqual({ think: true });
    expect(built.profile.from).toEqual({
      experimentId: 'e1',
      experimentName: 'reasoning on dispatch turns',
      variantLabel: 'think=true',
      verified: 2,
      runs: 2,
      tasks: 2,
      wasBest: true,
      promotedAt: '2026-08-04T12:00:00.000Z',
    });
  });

  it('allows promoting a variant that did not win, but says so', () => {
    const built = buildPromotion(won, 'think=false', null, 'u1')!;
    expect(built.standing.wasBest).toBe(false);
    expect(built.standing.rank).toBe(2);
    expect(built.profile.from!.wasBest).toBe(false);
  });

  it('builds on the profile already in force rather than replacing it wholesale', () => {
    const current: HarnessProfile = {
      ownerId: 'u1',
      overrides: { temperature: 0.2, max_tokens: 900 },
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const built = buildPromotion(won, 'think=true', current, 'u1')!;

    expect(built.profile.overrides).toEqual({ temperature: 0.2, max_tokens: 900, think: true });
    expect(built.changes).toEqual([
      { key: 'think', label: 'Reasoning on dispatch turns', from: undefined, to: true },
    ]);
  });

  it('returns nothing for a variant the experiment does not have', () => {
    expect(buildPromotion(won, 'nope', null, 'u1')).toBeNull();
  });
});

describe('effectiveOverrides', () => {
  it('puts the profile beneath the caller, so a promoted value stays testable', () => {
    const profile: HarnessProfile = {
      ownerId: 'u1', overrides: { think: true, temperature: 0.2 }, updatedAt: 'x',
    };
    expect(effectiveOverrides(profile, { think: false })).toEqual({ think: false, temperature: 0.2 });
  });

  it('is just the caller\'s own when nothing has been promoted', () => {
    expect(effectiveOverrides(null, { think: true })).toEqual({ think: true });
  });

  it('lets null opt a variant out of an adopted default', () => {
    const profile: HarnessProfile = {
      ownerId: 'u1', overrides: { systemPrompt: 'promoted', temperature: 0.2 }, updatedAt: 'x',
    };
    expect(effectiveOverrides(profile, { systemPrompt: null }))
      .toEqual({ temperature: 0.2 });
  });
});

describe('profile history', () => {
  const now = '2026-08-04T12:00:00.000Z';
  const inForce: HarnessProfile = {
    ownerId: 'u1',
    overrides: { think: true },
    from: {
      experimentId: 'e1', experimentName: 'first', variantLabel: 'think=true',
      verified: 2, runs: 2, tasks: 2, wasBest: true, promotedAt: '2026-08-01T00:00:00.000Z',
    },
    updatedAt: '2026-08-01T00:00:00.000Z',
  };

  it('files the outgoing configuration instead of overwriting it', () => {
    const next = supersede(inForce, { ownerId: 'u1', overrides: { think: false }, updatedAt: '' }, now);

    expect(next.overrides).toEqual({ think: false });
    expect(next.history).toHaveLength(1);
    expect(next.history![0]!.overrides).toEqual({ think: true });
    expect(next.history![0]!.from!.experimentName).toBe('first');
    expect(next.history![0]!.supersededAt).toBe(now);
  });

  it('files nothing when there was nothing in force', () => {
    expect(supersede(null, { ownerId: 'u1', overrides: { think: true }, updatedAt: '' }, now).history)
      .toBeUndefined();
  });

  it('restores a superseded configuration', () => {
    const second = supersede(inForce, { ownerId: 'u1', overrides: { think: false }, updatedAt: '' }, now);
    const back = revertTo(second, second.history![0]!.id, now)!;

    expect(back.overrides).toEqual({ think: true });
    expect(back.history!.map((v) => v.overrides)).toEqual([{ think: true }, { think: false }]);
  });

  it('returns nothing for a version that does not exist', () => {
    expect(revertTo(inForce, 'nope')).toBeNull();
  });

  it('keeps history bounded, dropping the oldest first', () => {
    let p: HarnessProfile = inForce;
    for (let i = 0; i < MAX_PROFILE_HISTORY + 5; i++) {
      p = supersede(p, { ownerId: 'u1', overrides: { maxSteps: i }, updatedAt: '' }, now);
    }
    expect(p.history).toHaveLength(MAX_PROFILE_HISTORY);
    expect(p.history![p.history!.length - 1]!.overrides).toEqual({ maxSteps: MAX_PROFILE_HISTORY + 3 });
  });
});

describe('changing only the overrides', () => {
  const promoted: HarnessProfile = {
    ownerId: 'u1',
    overrides: { temperature: 0.2 } as never,
    personaId: 'persona-that-won',
    from: { experimentId: 'e1', variantId: 'v1', promotedAt: '2026-01-01T00:00:00.000Z' } as never,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('keeps the persona the promotion adopted', () => {
    const next = withOverrides(promoted, { temperature: 0.9 } as never);
    expect(next.personaId).toBe('persona-that-won');
  });

  it('keeps where the promotion came from', () => {
    expect(withOverrides(promoted, { temperature: 0.9 } as never).from).toEqual(promoted.from);
  });

  it('applies the overrides it was given', () => {
    expect(withOverrides(promoted, { temperature: 0.9 } as never).overrides).toEqual({ temperature: 0.9 });
  });

  it('adds nothing to a profile that was never promoted', () => {
    const plain: HarnessProfile = { ownerId: 'u1', overrides: {} as never, updatedAt: 'x' };
    const next = withOverrides(plain, { temperature: 0.1 } as never);
    expect('personaId' in next).toBe(false);
    expect('from' in next).toBe(false);
  });
});
