import { api } from './client'

export type EvalCategory = 'simple' | 'multiple' | 'irrelevance'

export type ArgCheck =
  | { arg: string; is: string }
  | { arg: string; contains: string }
  | { arg: string; matches: string }
  | { arg: string; nonEmpty: true }

export interface Expectation {
  tool: string | null
  args?: ArgCheck[]
}

export interface EvalCase {
  name: string
  category: EvalCategory
  agent: string
  say: string
  expect: Expectation
  repeats?: number
  provokes?: { tool: string; when: string }
  mine?: boolean
  updatedAt?: string
}

export interface EvalCaseSummary {
  name: string
  category: string
  agent: string
  say: string
  expects: string | null
}

export type CoverageKind = 'uncovered' | 'unprovoked' | 'malformed'

export interface CoverageGap {
  case: string
  message: string
  kind: CoverageKind
}

export interface ToolScore {
  tool: string
  cases: number
  attempts: number
  passed: number
  complaints: string[]
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

export interface AttemptRecord {
  attempt: number
  passed: boolean
  complaint?: string
  error?: string
  systemHash?: string
  toolsOffered: string[]
  content: string
  thinking: string
  toolCalls: { name: string; arguments: string }[]
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
}

export interface CaseResult {
  name: string
  category: string
  agent: string
  expects: string | null
  attempts: AttemptRecord[]
}

export type RunState = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface ModelChoice {
  id: string
  name: string
  model: string
  sourceLabel?: string
  source: 'deployment' | 'endpoint'
}

export interface Sampling {
  toolTurn?: Record<string, number | undefined>
  conversation?: Record<string, number | undefined>
}

export interface Level1Run {
  id: string
  state: RunState
  startedAt: string
  finishedAt?: string
  repeats: number
  modelId?: string
  modelLabel?: string
  sampling?: Sampling
  maxTokens?: number
  toolCatalogueHash: string
  cases: string[]
  finished: number
  running?: string
  results: CaseResult[]
  error?: string
  summary: { reliability: Reliability; tools: ToolScore[] }
}

export interface Rate {
  passed: number
  attempts: number
}

export interface RunComparison {
  before: string
  after: string
  differences: { what: string; before: string; after: string }[]
  cases: { name: string; before?: Rate; after?: Rate; change?: number }[]
  tools: { tool: string; before: Rate; after: Rate; change: number }[]
}

export interface StartLevel1Input {
  repeats?: number
  only?: string[]
  modelId?: string
  modelLabel?: string
  temperature?: number
  maxTokens?: number
}

export async function listCases(): Promise<{ cases: EvalCase[]; coverage: CoverageGap[] }> {
  const { data } = await api.get<{ cases: EvalCase[]; coverage: CoverageGap[] }>('/evals/level1/cases')
  return data
}

export async function saveCase(entry: EvalCase): Promise<EvalCase> {
  const { data } = await api.put<{ case: EvalCase }>(`/evals/level1/cases/${entry.name}`, entry)
  return data.case
}

export async function deleteCase(name: string): Promise<void> {
  await api.delete(`/evals/level1/cases/${name}`)
}

export async function listLevel1Runs(): Promise<Level1Run[]> {
  const { data } = await api.get<{ runs: Level1Run[] }>('/evals/level1/runs')
  return data.runs
}

export async function getLevel1Run(id: string): Promise<Level1Run> {
  const { data } = await api.get<Level1Run>(`/evals/level1/runs/${id}`)
  return data
}

export async function startLevel1Run(input: StartLevel1Input): Promise<Level1Run> {
  const { data } = await api.post<Level1Run>('/evals/level1/runs', input)
  return data
}

export async function cancelLevel1Run(id: string): Promise<void> {
  await api.post(`/evals/level1/runs/${id}/cancel`, {})
}

export async function getPrompt(hash: string): Promise<string> {
  const { data } = await api.get<{ hash: string; text: string }>(`/evals/level1/prompts/${hash}`)
  return data.text
}

export async function compareLevel1Runs(before: string, after: string): Promise<RunComparison> {
  const { data } = await api.get<RunComparison>('/evals/level1/compare', { params: { before, after } })
  return data
}

export type TaskStatus = 'proposed' | 'accepted' | 'running' | 'done' | 'failed' | 'dropped'

export interface WorldTask {
  id: string
  title: string
  doneMeans: string
  status?: TaskStatus
  agent?: string
  dependsOn?: string[]
}

export interface ScenarioWorld {
  tasks?: WorldTask[]
  procedures?: unknown[]
  memories?: { title: string; text: string; category?: string }[]
  files?: Record<string, string>
  acceptProposedWork?: boolean
}

export interface ScenarioExpectations {
  outcome?: string
  toolsCalled?: string[]
  toolsNotCalled?: string[]
  toolsInOrder?: string[]
  tasks?: { id: string; status: TaskStatus }[]
  within?: { rounds?: number; toolCalls?: number; totalTokens?: number }
  provokes?: { tool: string; when: string; then: 'retried' | 'reported' }
  saved?: { procedure: string; stored: boolean }
}

export interface Scenario {
  id: string
  name: string
  describe: string
  agent: string
  procedure: { id: string; version?: string }
  input: { message: string; inputs?: Record<string, unknown> }
  world?: ScenarioWorld
  answers?: Record<string, unknown>
  approvals?: 'allow' | 'refuse'
  expect: ScenarioExpectations
  mine?: boolean
  updatedAt?: string
}

export interface Check {
  what: string
  passed: boolean
  detail: string
}

export interface ScenarioResult {
  scenarioId: string
  name: string
  runId: string
  procedure: { id: string; version: string }
  passed: boolean
  outcome: string
  reason?: string
  answer: string
  checks: Check[]
  calls: { name: string; ok: boolean; digest: string }[]
  counters: { rounds: number; toolCalls: number; totalTokens: number }
  tasks: { id: string; title: string; status: string; evidence?: string }[]
  durationMs: number
  error?: string
}

export interface Level2Run {
  id: string
  state: RunState
  startedAt: string
  finishedAt?: string
  modelId?: string
  modelLabel?: string
  sampling?: Sampling
  scenarios: string[]
  finished: number
  running?: string
  results: ScenarioResult[]
  error?: string
}

export interface StartLevel2Input {
  only?: string[]
  modelId?: string
  modelLabel?: string
  temperature?: number
}

export async function listScenarios(): Promise<Scenario[]> {
  const { data } = await api.get<{ scenarios: Scenario[] }>('/evals/level2/scenarios')
  return data.scenarios
}

export async function saveScenario(scenario: Scenario): Promise<Scenario> {
  const { data } = await api.put<{ scenario: Scenario }>(`/evals/level2/scenarios/${scenario.id}`, scenario)
  return data.scenario
}

export async function deleteScenario(id: string): Promise<void> {
  await api.delete(`/evals/level2/scenarios/${id}`)
}

export async function listLevel2Runs(): Promise<Level2Run[]> {
  const { data } = await api.get<{ runs: Level2Run[] }>('/evals/level2/runs')
  return data.runs
}

export async function getLevel2Run(id: string): Promise<Level2Run> {
  const { data } = await api.get<Level2Run>(`/evals/level2/runs/${id}`)
  return data
}

export async function startLevel2Run(input: StartLevel2Input): Promise<Level2Run> {
  const { data } = await api.post<Level2Run>('/evals/level2/runs', input)
  return data
}

export async function cancelLevel2Run(id: string): Promise<void> {
  await api.post(`/evals/level2/runs/${id}/cancel`, {})
}

export async function listModels(): Promise<ModelChoice[]> {
  const { data } = await api.get('/models')
  return Array.isArray(data) ? data : (data.models ?? [])
}
