import { describe, it, expect } from 'vitest';
import { compareCheckRuns, NO_TOOL, type ComparableCheckRun } from './check-compare.js';
import type { ScenarioResult } from '../eval/level2/results.js';

const result = (id: string, passes: boolean[]): ScenarioResult => ({
  scenarioId: id, name: id, runId: `run-${id}`, procedure: { id: 'turn-check', version: '1' }, passed: passes.every(Boolean), outcome: 'ok', answer: '',
  checks: [], calls: [], counters: { rounds: 1, toolCalls: 0, totalTokens: 1 }, tasks: [], durationMs: 1,
  ...(passes.length > 1 ? { attempts: passes.map((passed, index) => ({ runId: `run-${id}-${index}`, passed, durationMs: 1, checks: [], calls: [] })) } : {}),
});

const run = (id: string, over: Partial<ComparableCheckRun>, results: ScenarioResult[]): ComparableCheckRun => ({ id, startedAt: id, results, ...over });

const chosen = (id: string) => ({ 'turn-claims': 'start_task', 'turn-reads': 'read_file', 'turn-declines': null } as Record<string, string | null>)[id];

describe('comparing two check runs', () => {
  it('names what was set up differently, including an agent whose prompt, tools or procedure changed', () => {
    const comparison = compareCheckRuns(
      run('a', { modelLabel: 'qwen', agents: { executor: 'f1', koala: 'k1' } }, []),
      run('b', { modelLabel: 'llama', trialPractice: 'p1', agents: { executor: 'f2', koala: 'k1' } }, []),
      chosen,
    );

    expect(comparison.differences).toEqual([
      { what: 'model', before: 'qwen', after: 'llama' },
      { what: 'practice on trial', before: 'not set', after: 'p1' },
      { what: 'executor\'s setup', before: 'as it was', after: 'changed — its prompt, tools or procedure' },
    ]);
  });

  it('puts the check that got worst first, counting every attempt, and keeps checks only one run has', () => {
    const comparison = compareCheckRuns(
      run('a', {}, [result('turn-claims', [true, true, true, true]), result('turn-reads', [true, false, false, false]), result('flow', [true])]),
      run('b', {}, [result('turn-claims', [true, false, false, false]), result('turn-reads', [true, true, true, true]), result('new', [false])]),
      chosen,
    );

    expect(comparison.checks.map((check) => [check.id, check.change])).toEqual([['turn-claims', -0.75], ['flow', undefined], ['new', undefined], ['turn-reads', 0.75]]);
    expect(comparison.checks.find((check) => check.id === 'turn-claims')).toMatchObject({ before: { passed: 4, attempts: 4 }, after: { passed: 1, attempts: 4 } });
  });

  it('sums turn checks by the tool they choose, over the checks both runs share', () => {
    const comparison = compareCheckRuns(
      run('a', {}, [result('turn-claims', [true, true]), result('turn-declines', [false, false]), result('flow', [true])]),
      run('b', {}, [result('turn-claims', [false, false]), result('turn-declines', [true, true])]),
      chosen,
    );

    expect(comparison.tools).toEqual([
      { tool: 'start_task', before: { passed: 2, attempts: 2 }, after: { passed: 0, attempts: 2 }, change: -1 },
      { tool: NO_TOOL, before: { passed: 0, attempts: 2 }, after: { passed: 2, attempts: 2 }, change: 1 },
    ]);
  });
});
