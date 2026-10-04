import { describe, it, expect } from 'vitest';
import { DEFAULT_BENCH_SETTINGS, benchPlan, benchSettingsProblems, fingerprintOf, regressionsIn, type BenchState } from './bench.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const scenarios = [
  { id: 'koala-cluster', agent: 'koala' },
  { id: 'koala-deploy', agent: 'koala' },
  { id: 'executor-hello', agent: 'executor' },
];
const prints = { koala: 'k2', executor: 'e1' };
const state = (over: Partial<BenchState> = {}): BenchState => ({ ownerId: 'u1', benched: { koala: 'k1', executor: 'e1' }, lastFullAt: hoursAgo(2), ...over });

describe('what the bench runs when the model goes idle', () => {
  it('runs every scenario when it has never run, or the last full run is older than the setting', () => {
    expect(benchPlan(scenarios, prints, state({ lastFullAt: undefined }), DEFAULT_BENCH_SETTINGS, NOW)).toEqual({ trigger: { kind: 'full' }, scenarioIds: ['koala-cluster', 'koala-deploy', 'executor-hello'] });
    expect(benchPlan(scenarios, prints, state({ lastFullAt: hoursAgo(25) }), DEFAULT_BENCH_SETTINGS, NOW)?.trigger).toEqual({ kind: 'full' });
  });

  it('otherwise runs only the scenarios of agents that changed since they were last benched', () => {
    expect(benchPlan(scenarios, prints, state(), DEFAULT_BENCH_SETTINGS, NOW)).toEqual({ trigger: { kind: 'changed', agents: ['koala'] }, scenarioIds: ['koala-cluster', 'koala-deploy'] });
  });

  it('runs nothing when nothing changed, or when it is switched off', () => {
    expect(benchPlan(scenarios, { koala: 'k1', executor: 'e1' }, state(), DEFAULT_BENCH_SETTINGS, NOW)).toBeUndefined();
    expect(benchPlan(scenarios, prints, state({ lastFullAt: undefined }), { ...DEFAULT_BENCH_SETTINGS, enabled: false }, NOW)).toBeUndefined();
  });

  it('leaves out a scenario whose agent no longer exists, rather than calling it changed', () => {
    expect(benchPlan(scenarios, { koala: 'k1' }, state(), DEFAULT_BENCH_SETTINGS, NOW)).toBeUndefined();
  });
});

describe('a regression', () => {
  it('is a scenario that fails now and passed the last time it ran', () => {
    const earlier = [
      { results: [{ scenarioId: 'a', passed: true }] },
      { results: [{ scenarioId: 'a', passed: false }, { scenarioId: 'b', passed: true }, { scenarioId: 'c', passed: false }] },
    ];
    expect(regressionsIn([{ scenarioId: 'a', passed: false }, { scenarioId: 'b', passed: false }, { scenarioId: 'c', passed: false }, { scenarioId: 'd', passed: false }], earlier)).toEqual(['a', 'b']);
  });

  it('is never a scenario that passes now', () => {
    expect(regressionsIn([{ scenarioId: 'a', passed: true }], [{ results: [{ scenarioId: 'a', passed: true }] }])).toEqual([]);
  });
});

describe('an agent\'s fingerprint', () => {
  it('ignores the order of keys and fields left undefined, and changes when anything that matters does', () => {
    expect(fingerprintOf({ a: 1, b: { c: 2 } })).toBe(fingerprintOf({ b: { c: 2 }, a: 1, d: undefined }));
    expect(fingerprintOf({ prompt: 'one' })).not.toBe(fingerprintOf({ prompt: 'two' }));
  });
});

describe('bench settings', () => {
  it('need an on switch and positive times', () => {
    expect(benchSettingsProblems(DEFAULT_BENCH_SETTINGS)).toEqual([]);
    expect(benchSettingsProblems({ enabled: true, idleMinutes: 0, fullEveryHours: -1 })).toHaveLength(2);
    expect(benchSettingsProblems(null)).toEqual(['bench settings have to be an object']);
  });
});
