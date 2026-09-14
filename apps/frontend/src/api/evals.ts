import { api } from './client'

export type EvalCategory = 'simple' | 'multiple' | 'irrelevance'

export interface EvalCaseSummary {
  name: string
  category: EvalCategory
  agent: string
  say: string
  expects: string | null
}

export interface CoverageGap {
  case: string
  message: string
}

export interface CaseOutcome {
  name: string
  category: string
  attempts: number
  passed: number
  complaints: string[]
}

export interface Reliability {
  cases: number
  always: number
  never: number
  flaky: number
}

export type EvalRunState = 'running' | 'done' | 'failed' | 'cancelled'

export interface ModelChoice {
  id: string
  name: string
  model: string
  sourceLabel?: string
  source: 'deployment' | 'endpoint'
}

export interface EvalRun {
  id: string
  state: EvalRunState
  startedAt: string
  finishedAt?: string
  repeats: number
  modelId?: string
  modelLabel?: string
  total: number
  finished: number
  running?: string
  outcomes: CaseOutcome[]
  reliability?: Reliability
  error?: string
}

export async function listCases(): Promise<{ cases: EvalCaseSummary[]; coverage: CoverageGap[] }> {
  const { data } = await api.get('/evals/cases')
  return data
}

export async function listRuns(): Promise<EvalRun[]> {
  const { data } = await api.get('/evals/runs')
  return data.runs
}

export async function getRun(id: string): Promise<EvalRun> {
  const { data } = await api.get(`/evals/runs/${id}`)
  return data
}

export async function listModels(): Promise<ModelChoice[]> {
  const { data } = await api.get('/models')
  return Array.isArray(data) ? data : (data.models ?? [])
}

export async function startRun(input: {
  repeats?: number
  only?: string[]
  modelId?: string
  modelLabel?: string
}): Promise<EvalRun> {
  const { data } = await api.post('/evals/runs', input)
  return data
}

export async function cancelRun(id: string): Promise<void> {
  await api.post(`/evals/runs/${id}/cancel`, {})
}

export function standing(outcome: CaseOutcome): 'pass' | 'fail' | 'flaky' {
  if (outcome.passed === outcome.attempts) return 'pass'
  return outcome.passed === 0 ? 'fail' : 'flaky'
}
