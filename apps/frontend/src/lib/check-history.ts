import type { Level2Run, ScenarioResult } from '../api/evals'

export interface CheckOutcome {
  runId: string
  at: string
  modelLabel?: string | undefined
  result?: ScenarioResult | undefined
  running: boolean
  regressed: boolean
}

const TRIALS = ['practice', 'prompt-change']

export function historyOf(runs: readonly Level2Run[], scenarioId: string, limit = 8): CheckOutcome[] {
  return runs
    .filter((run) => run.scenarios.includes(scenarioId) && !TRIALS.includes(run.trigger?.kind ?? ''))
    .map((run) => ({
      runId: run.id,
      at: run.startedAt,
      modelLabel: run.modelLabel ?? run.modelId,
      result: run.results.find((result) => result.scenarioId === scenarioId),
      running: run.state === 'running' && !run.results.some((result) => result.scenarioId === scenarioId),
      regressed: (run.regressions ?? []).includes(scenarioId),
    }))
    .filter((outcome) => outcome.result || outcome.running)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
}

export interface Rate {
  passed: number
  attempts: number
}

export const rateOf = (result: ScenarioResult): Rate => (result.attempts
  ? { passed: result.attempts.filter((attempt) => attempt.passed).length, attempts: result.attempts.length }
  : { passed: result.passed ? 1 : 0, attempts: 1 })

export function runLabel(run: Level2Run): string {
  const when = new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const passed = run.results.filter((result) => result.passed).length
  return [
    when,
    run.modelLabel ?? run.modelId ?? 'your default model',
    `${passed}/${run.results.length} passed`,
    ...(run.trigger && run.trigger.kind !== 'manual' ? [`bench: ${run.trigger.kind}`] : []),
  ].join(' · ')
}

export interface ToolReliability extends Rate {
  checks: number
}

export function toolReliability(runs: readonly Level2Run[], turnChecks: readonly string[]): ToolReliability | undefined {
  const latest = turnChecks.flatMap((id) => {
    const result = historyOf(runs, id, 1)[0]?.result
    return result ? [rateOf(result)] : []
  })
  if (latest.length === 0) return undefined
  return {
    checks: latest.length,
    passed: latest.reduce((sum, rate) => sum + rate.passed, 0),
    attempts: latest.reduce((sum, rate) => sum + rate.attempts, 0),
  }
}
