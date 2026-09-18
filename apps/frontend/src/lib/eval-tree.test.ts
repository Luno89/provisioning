import { describe, it, expect } from 'vitest'
import { groupCases, statusOf, tally, failingNames, matchesFilter } from './eval-tree'
import type { CaseOutcome, EvalCaseSummary } from '../api/evals'

const summary = (name: string, agent: string): EvalCaseSummary => ({
  name,
  agent,
  category: 'simple',
  say: `do ${name}`,
  expects: 'some_tool',
})

const outcome = (name: string, passed: number, attempts: number, complaints: string[] = []): CaseOutcome => ({
  name,
  category: 'simple',
  attempts,
  passed,
  complaints,
})

describe('what a case counts as', () => {
  it('is pending before anything has run it', () => {
    expect(statusOf(undefined, false)).toBe('pending')
  })

  it('is running while it is the one in flight, even with an older result', () => {
    expect(statusOf(outcome('a', 10, 10), true)).toBe('running')
  })

  it('separates every-time from some-of-the-time from never', () => {
    expect(statusOf(outcome('a', 10, 10), false)).toBe('pass')
    expect(statusOf(outcome('a', 7, 10), false)).toBe('flaky')
    expect(statusOf(outcome('a', 0, 10), false)).toBe('fail')
  })
})

describe('grouping cases by the persona that runs them', () => {
  const cases = [
    summary('executor/reads', 'executor'),
    summary('executor/writes', 'executor'),
    summary('research/searches', 'research'),
  ]

  it('puts each case under its persona and shortens the label', () => {
    const groups = groupCases(cases, [])

    expect(groups.map((group) => group.persona)).toEqual(['executor', 'research'])
    expect(groups[0]!.rows.map((row) => row.label)).toEqual(['reads', 'writes'])
  })

  it('adds up attempts across a persona', () => {
    const groups = groupCases(cases, [outcome('executor/reads', 8, 10), outcome('executor/writes', 10, 10)])
    const executor = groups.find((group) => group.persona === 'executor')!

    expect(executor.passed).toBe(18)
    expect(executor.attempts).toBe(20)
  })

  it('takes the worst case as the persona\'s standing', () => {
    const groups = groupCases(cases, [outcome('executor/reads', 0, 10), outcome('executor/writes', 10, 10)])

    expect(groups.find((group) => group.persona === 'executor')!.status).toBe('fail')
  })

  it('sorts the personas worth looking at first', () => {
    const groups = groupCases(cases, [
      outcome('executor/reads', 10, 10),
      outcome('executor/writes', 10, 10),
      outcome('research/searches', 0, 10),
    ])

    expect(groups.map((group) => group.persona)).toEqual(['research', 'executor'])
  })

  it('does not repeat a complaint two attempts both made', () => {
    const groups = groupCases(cases, [outcome('executor/reads', 5, 10, ['wrong tool', 'wrong tool'])])

    expect(groups[0]!.rows[0]!.complaints).toEqual(['wrong tool'])
  })
})

describe('the summary line', () => {
  const cases = [
    summary('a/one', 'a'),
    summary('a/two', 'a'),
    summary('b/one', 'b'),
    summary('b/two', 'b'),
  ]

  it('counts every case by what it is currently', () => {
    const groups = groupCases(cases, [
      outcome('a/one', 10, 10),
      outcome('a/two', 4, 10),
      outcome('b/one', 0, 10),
    ], 'b/two')

    expect(tally(groups)).toEqual({ pass: 1, flaky: 1, fail: 1, pending: 0, running: 1 })
  })

  it('names what is worth re-running, which is failing and flaky both', () => {
    const groups = groupCases(cases, [
      outcome('a/one', 10, 10),
      outcome('a/two', 4, 10),
      outcome('b/one', 0, 10),
    ])

    expect(failingNames(groups)).toEqual(['b/one', 'a/two'])
  })
})

describe('filtering to what is worth looking at', () => {
  const row = (status: 'pass' | 'fail' | 'flaky' | 'pending') =>
    groupCases([summary('a/one', 'a')], status === 'pending' ? [] : [
      outcome('a/one', status === 'pass' ? 10 : status === 'flaky' ? 5 : 0, 10),
    ])[0]!.rows[0]!

  it('keeps everything under all', () => {
    expect(matchesFilter(row('pass'), 'all')).toBe(true)
  })

  it('keeps only what failed or wobbled under problems', () => {
    expect(matchesFilter(row('fail'), 'problems')).toBe(true)
    expect(matchesFilter(row('flaky'), 'problems')).toBe(true)
    expect(matchesFilter(row('pass'), 'problems')).toBe(false)
    expect(matchesFilter(row('pending'), 'problems')).toBe(false)
  })
})
