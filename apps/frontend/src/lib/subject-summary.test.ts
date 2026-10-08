import { describe, it, expect } from 'vitest'
import { checksSummary, describeChecks, describePractices, waitingFor } from './subject-summary'
import type { Level2Run, Scenario, ScenarioResult } from '../api/evals'

const scenario = (id: string, agent: string): Scenario => ({ id, name: id, describe: '', agent, procedure: { id: 'p' }, input: { message: 'x' }, expect: {} })
const result = (scenarioId: string, passed: boolean) => ({ scenarioId, passed } as ScenarioResult)

describe('what an agent\'s overview says about each part', () => {
  it('counts its checks by how each last went', () => {
    const scenarios = [scenario('a', 'koala'), scenario('b', 'koala'), scenario('c', 'koala'), scenario('d', 'research')]
    const runs = [
      { id: 'new', state: 'done', startedAt: '2026-10-02', scenarios: ['b'], finished: 1, results: [result('b', false)], regressions: ['b'] },
      { id: 'old', state: 'done', startedAt: '2026-10-01', scenarios: ['a', 'b'], finished: 2, results: [result('a', true), result('b', true)] },
    ] as Level2Run[]
    const summary = checksSummary(scenarios, runs, { agent: 'koala' })
    expect(summary).toEqual({ count: 3, passing: 1, failing: 1, regressed: 1, neverRun: 1 })
    expect(describeChecks(summary)).toBe('1 of 3 passing · 1 regressed · 1 never run')
    expect(describeChecks(checksSummary([], [], { agent: 'koala' }))).toBe('no checks yet')
  })

  it('counts its practices and what waits for the person', () => {
    const practices = [
      { id: '1', agent: 'koala', status: 'active' }, { id: '2', agent: 'koala', status: 'trial' }, { id: '3', agent: 'research', status: 'active' },
    ] as never
    expect(describePractices(practices, 'koala')).toBe('1 practice live · 1 on trial')
    expect(waitingFor('koala', [{ status: 'proposed', scenario: { agent: 'koala' } }, { status: 'accepted', scenario: { agent: 'koala' } }] as never, [{ status: 'ready', agent: 'koala' }, { status: 'proposed', agent: 'research' }] as never)).toBe(2)
  })
})
