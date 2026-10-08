import type { AgentChange, Level2Run, Practice, Scenario, ScenarioProposal } from '../api/evals'
import { scenarioSubjects, within, type Scope } from './check-subjects'
import { historyOf } from './check-history'

export interface ChecksSummary {
  count: number
  passing: number
  failing: number
  regressed: number
  neverRun: number
}

export function checksSummary(scenarios: readonly Scenario[], runs: readonly Level2Run[], scope: Scope): ChecksSummary {
  const latest = scenarios
    .filter((scenario) => within(scenarioSubjects(scenario), scope))
    .map((scenario) => historyOf(runs, scenario.id, 1)[0])
  const settled = latest.filter((outcome) => outcome?.result)
  return {
    count: latest.length,
    passing: settled.filter((outcome) => outcome!.result!.passed).length,
    failing: settled.filter((outcome) => !outcome!.result!.passed).length,
    regressed: settled.filter((outcome) => outcome!.regressed).length,
    neverRun: latest.filter((outcome) => !outcome?.result).length,
  }
}

export function describeChecks(summary: ChecksSummary): string {
  if (summary.count === 0) return 'no checks yet'
  const parts = [`${summary.passing} of ${summary.count} passing`]
  if (summary.regressed > 0) parts.push(`${summary.regressed} regressed`)
  if (summary.neverRun > 0) parts.push(`${summary.neverRun} never run`)
  return parts.join(' · ')
}

export function describePractices(practices: readonly Practice[], agent: string): string {
  const own = practices.filter((practice) => practice.agent === agent)
  const live = own.filter((practice) => practice.status === 'active' || !practice.status).length
  const trial = own.filter((practice) => practice.status === 'trial').length
  const held = own.filter((practice) => practice.status === 'pending_review').length
  const parts = [`${live} practice${live === 1 ? '' : 's'} live`]
  if (trial > 0) parts.push(`${trial} on trial`)
  if (held > 0) parts.push(`${held} held for you`)
  return parts.join(' · ')
}

const WAITING = new Set(['proposed', 'comparing', 'ready'])

export function waitingFor(agent: string, proposals: readonly ScenarioProposal[], changes: readonly AgentChange[]): number {
  return proposals.filter((proposal) => proposal.status === 'proposed' && proposal.scenario.agent === agent).length
    + changes.filter((change) => WAITING.has(change.status) && change.agent === agent).length
}
