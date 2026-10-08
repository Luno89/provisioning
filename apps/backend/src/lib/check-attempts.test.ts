import { describe, it, expect } from 'vitest';
import { combineAttempts } from './check-attempts.js';
import type { ScenarioResult } from '../eval/level2/results.js';

const attempt = (runId: string, passed: boolean, detail = passed ? 'it called read_file' : 'called list_dir instead of read_file'): ScenarioResult => ({
  scenarioId: 'turn-reads',
  name: 'reads',
  runId,
  procedure: { id: 'turn-check', version: '1' },
  passed,
  outcome: 'ok',
  answer: '',
  checks: [{ what: 'chooses read_file', passed, detail }],
  calls: [],
  counters: { rounds: 1, toolCalls: 0, totalTokens: 10 },
  tasks: [],
  durationMs: 1000,
});

describe('a check repeated', () => {
  it('passes when enough attempts pass, and says how often each expectation held', () => {
    const result = combineAttempts([attempt('r1', true), attempt('r2', false), attempt('r3', true)], 2);

    expect(result.passed).toBe(true);
    expect(result.passedAttempts).toBe(2);
    expect(result.checks).toEqual([
      { what: 'passes at least 2 of 3 times', passed: true, detail: '2 of 3 passed' },
      { what: 'chooses read_file — 2/3', passed: false, detail: 'called list_dir instead of read_file' },
    ]);
    expect(result.attempts?.map((one) => [one.runId, one.passed])).toEqual([['r1', true], ['r2', false], ['r3', true]]);
    expect(result.durationMs).toBe(3000);
  });

  it('fails when fewer pass than it needs, and shows the first attempt that failed', () => {
    const result = combineAttempts([attempt('r1', true), attempt('r2', false), attempt('r3', false)], 3);

    expect(result.passed).toBe(false);
    expect(result.runId).toBe('r2');
    expect(result.checks[0]).toEqual({ what: 'passes all 3 times', passed: false, detail: '1 of 3 passed' });
  });

  it('keeps an error only when every attempt broke, and says what broke either way', () => {
    const broke = { ...attempt('r2', false), checks: [], error: 'the run would not start' };
    const some = combineAttempts([attempt('r1', true), broke], 1);
    expect(some.error).toBeUndefined();
    expect(some.checks[0]!.detail).toBe('1 of 2 passed; one broke: the run would not start');

    const all = combineAttempts([broke, { ...broke, runId: 'r3' }], 1);
    expect(all.error).toBe('the run would not start');
  });
});
