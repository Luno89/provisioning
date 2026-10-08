import { describe, it, expect } from 'vitest'
import { historyOf, rateOf, toolReliability } from './check-history'
import type { Level2Run, ScenarioResult } from '../api/evals'

const result = (scenarioId: string, passed: boolean) => ({ scenarioId, passed } as ScenarioResult)
const run = (id: string, startedAt: string, scenarios: string[], results: ScenarioResult[], extra: Partial<Level2Run> = {}): Level2Run =>
  ({ id, state: 'done', startedAt, scenarios, finished: results.length, results, ...extra })

describe('a check\'s history', () => {
  it('lists the runs that included it, newest first, leaving out practice and prompt trials and runs that never got to it', () => {
    const runs = [
      run('a', '2026-10-01', ['s', 't'], [result('s', true), result('t', false)]),
      run('b', '2026-10-03', ['s'], [result('s', false)], { regressions: ['s'] }),
      run('trial', '2026-10-04', ['s'], [result('s', true)], { trigger: { kind: 'practice' } as never }),
      run('other', '2026-10-05', ['t'], [result('t', true)]),
      run('cancelled', '2026-10-02', ['s'], [], { state: 'failed' }),
      run('now', '2026-10-06', ['s', 't'], [result('t', true)], { state: 'running' }),
    ]

    expect(historyOf(runs, 's').map((outcome) => [outcome.runId, outcome.running, outcome.result?.passed, outcome.regressed])).toEqual([
      ['now', true, undefined, false],
      ['b', false, false, true],
      ['a', false, true, false],
    ])
  })
})

describe('how reliably a tool is chosen', () => {
  const repeated = (scenarioId: string, passes: boolean[]) => ({
    scenarioId, passed: passes.every(Boolean),
    attempts: passes.map((passed, index) => ({ runId: `${scenarioId}-${index}`, passed, durationMs: 1, checks: [], calls: [] })),
  } as unknown as ScenarioResult)

  it('counts every attempt of a repeated check, and a single run as one', () => {
    expect(rateOf(repeated('t', [true, false, true]))).toEqual({ passed: 2, attempts: 3 })
    expect(rateOf(result('s', true))).toEqual({ passed: 1, attempts: 1 })
  })

  it('sums the latest result of each turn check that chooses it, and says nothing when none has run', () => {
    const runs = [
      run('old', '2026-10-01', ['claims'], [repeated('claims', [false, false])]),
      run('new', '2026-10-02', ['claims', 'records'], [repeated('claims', [true, true, false]), repeated('records', [true, true])]),
    ]
    expect(toolReliability(runs, ['claims', 'records', 'never-run'])).toEqual({ checks: 2, passed: 4, attempts: 5 })
    expect(toolReliability(runs, ['never-run'])).toBeUndefined()
  })
})
