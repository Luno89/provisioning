import type { CaseOutcome, EvalCaseSummary } from '../api/evals'

export type CaseStatus = 'pending' | 'running' | 'pass' | 'flaky' | 'fail'

export interface CaseRow {
  name: string
  persona: string
  label: string
  category: string
  say: string
  expects: string | null
  status: CaseStatus
  passed: number
  attempts: number
  complaints: string[]
}

export interface PersonaGroup {
  persona: string
  rows: CaseRow[]
  passed: number
  attempts: number
  status: CaseStatus
}

export interface RunTally {
  pass: number
  flaky: number
  fail: number
  pending: number
  running: number
}

export const STATUS_ORDER: CaseStatus[] = ['fail', 'flaky', 'running', 'pending', 'pass']

export function statusOf(outcome: CaseOutcome | undefined, isRunning: boolean): CaseStatus {
  if (isRunning) return 'running'
  if (!outcome) return 'pending'
  if (outcome.passed === outcome.attempts) return 'pass'
  if (outcome.passed === 0) return 'fail'
  return 'flaky'
}

const worstOf = (statuses: readonly CaseStatus[]): CaseStatus => {
  for (const candidate of STATUS_ORDER) {
    if (statuses.includes(candidate)) return candidate
  }
  return 'pending'
}

const labelOf = (name: string): string => {
  const slash = name.indexOf('/')
  return slash === -1 ? name : name.slice(slash + 1)
}

export function groupCases(
  cases: readonly EvalCaseSummary[],
  outcomes: readonly CaseOutcome[],
  running?: string | undefined,
): PersonaGroup[] {
  const byName = new Map(outcomes.map((outcome) => [outcome.name, outcome]))
  const groups = new Map<string, CaseRow[]>()

  for (const entry of cases) {
    const outcome = byName.get(entry.name)
    const row: CaseRow = {
      name: entry.name,
      persona: entry.agent,
      label: labelOf(entry.name),
      category: entry.category,
      say: entry.say,
      expects: entry.expects,
      status: statusOf(outcome, running === entry.name),
      passed: outcome?.passed ?? 0,
      attempts: outcome?.attempts ?? 0,
      complaints: [...new Set(outcome?.complaints ?? [])],
    }

    groups.set(entry.agent, [...(groups.get(entry.agent) ?? []), row])
  }

  return [...groups.entries()]
    .map(([persona, rows]) => ({
      persona,
      rows,
      passed: rows.reduce((sum, row) => sum + row.passed, 0),
      attempts: rows.reduce((sum, row) => sum + row.attempts, 0),
      status: worstOf(rows.map((row) => row.status)),
    }))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
      || a.persona.localeCompare(b.persona))
}

export function tally(groups: readonly PersonaGroup[]): RunTally {
  const counts: RunTally = { pass: 0, flaky: 0, fail: 0, pending: 0, running: 0 }
  for (const group of groups) {
    for (const row of group.rows) counts[row.status] += 1
  }
  return counts
}

export function failingNames(groups: readonly PersonaGroup[]): string[] {
  return groups
    .flatMap((group) => group.rows)
    .filter((row) => row.status === 'fail' || row.status === 'flaky')
    .map((row) => row.name)
}

export function matchesFilter(row: CaseRow, filter: 'all' | 'problems'): boolean {
  return filter === 'all' || row.status === 'fail' || row.status === 'flaky'
}
