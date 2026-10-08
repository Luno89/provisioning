import { api } from './client'
import type { Procedure } from '@koala/agent-engine/procedure'

export type ArgCheck =
  | { arg: string; is: string }
  | { arg: string; contains: string }
  | { arg: string; matches: string }
  | { arg: string; nonEmpty: true }

export interface TurnChoice {
  tool: string | null
  args?: ArgCheck[]
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

export interface Rate {
  passed: number
  attempts: number
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `CheckRunComparison` in apps/backend/src/lib/check-compare.ts and `CoverageGap` in
 * apps/backend/src/lib/check-coverage.ts.
 */
export interface CheckRunComparison {
  before: string
  after: string
  differences: { what: string; before: string; after: string }[]
  checks: { id: string; name: string; before?: Rate; after?: Rate; change?: number }[]
  tools: { tool: string; before: Rate; after: Rate; change: number }[]
}

export type CoverageGap =
  | { kind: 'uncovered'; tool: string; message: string }
  | { kind: 'unprovoked'; tool: string; when: string; message: string }
  | { kind: 'no-restraint'; agent: string; message: string }

export async function getCoverage(): Promise<CoverageGap[]> {
  const { data } = await api.get<{ gaps: CoverageGap[] }>('/evals/level2/coverage')
  return data.gaps
}

export async function getCheckProcedure(id: string): Promise<{ procedure: Procedure }> {
  const { data } = await api.get<{ procedure: Procedure }>(`/evals/level2/scenarios/${encodeURIComponent(id)}/procedure`)
  return data
}

export async function compareCheckRuns(before: string, after: string): Promise<CheckRunComparison> {
  const { data } = await api.get<CheckRunComparison>('/evals/level2/compare', { params: { before, after } })
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
  agents?: Record<string, Record<string, unknown>>
  project?: { name: string }
}

export interface ScenarioExpectations {
  outcome?: string
  toolsCalled?: string[]
  toolsNotCalled?: string[]
  toolsSucceeded?: string[]
  toolsInOrder?: string[]
  tasks?: { id: string; status: TaskStatus }[]
  within?: { rounds?: number; toolCalls?: number; totalTokens?: number }
  provokes?: { tool: string; when: string; then: 'retried' | 'reported' }
  saved?: { procedure: string; stored: boolean }
  handOffs?: { agent: string; atLeast?: number; atMost?: number; together?: boolean }[]
  files?: { path: string; contains?: string[] }[]
  modelSaw?: { contains?: string[]; lacks?: string[] }
  compacted?: boolean
  summaryKept?: boolean
  interrupted?: boolean
  turnLog?: { complete: boolean }
  leaves?: { verified?: number; landed?: Record<string, 'merged' | 'nothing'>; mergeTasks?: number }
  repository?: { of: 'tree' | 'conversation'; files: { path: string; contains?: string[] }[] }
  pullRequests?: { merged?: number; open?: number; closedUnmerged?: number }
  workspace?: { of: 'tree' | 'conversation'; exists: boolean }
  project?: { exists: boolean }
  trees?: number
  exit?: string
  outputs?: Record<string, { equals?: unknown; contains?: string }>
  chooses?: TurnChoice
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `PLUMBING_KEYS` follows `FlowExpectations` in apps/backend/src/eval/level2/scenario.ts, `CheckScript`
 * in apps/backend/src/lib/check-script.ts, `StepUnderTest` in apps/backend/src/lib/step-check.ts.
 */
export const PLUMBING_KEYS = ['modelSaw', 'compacted', 'summaryKept', 'interrupted', 'turnLog', 'leaves', 'repository', 'pullRequests', 'workspace', 'project', 'trees', 'exit', 'outputs'] as const

export interface CheckScript {
  rules: { when: Record<string, unknown>; reply: { say?: string; call?: { tool: string; arguments: Record<string, unknown> }[]; paceMs?: number } }[]
  contextTokens?: number
}

export interface StepUnderTest {
  node: string
  settings?: Record<string, unknown>
  inputs?: Record<string, unknown>
  from?: string
}

export interface FlowStage {
  name: string
  do: Record<string, unknown>
  expect?: ScenarioExpectations
}

export interface Scenario {
  id: string
  name: string
  describe: string
  agent: string
  procedure: { id: string }
  input: { message: string; inputs?: Record<string, unknown> }
  world?: ScenarioWorld
  answers?: Record<string, unknown>
  approvals?: 'allow' | 'refuse'
  script?: CheckScript
  step?: StepUnderTest
  turn?: boolean
  repeats?: number
  passAt?: number
  expect: ScenarioExpectations
  then?: FlowStage[]
  mine?: boolean
  updatedAt?: string
}

export interface Check {
  what: string
  passed: boolean
  detail: string
}

export interface CheckAttempt {
  runId: string
  conversationId?: string
  passed: boolean
  durationMs: number
  checks: Check[]
  calls: { name: string; ok: boolean; digest: string }[]
  error?: string
}

export interface ScenarioResult {
  scenarioId: string
  name: string
  runId: string
  procedure: { id: string; version: string }
  conversationId?: string
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
  repeats?: number
  passAt?: number
  passedAttempts?: number
  attempts?: CheckAttempt[]
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
  trigger?: BenchTrigger
  regressions?: string[]
  trialPractice?: string
  agents?: Record<string, string>
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `BenchTrigger` in apps/backend/src/lib/bench.ts.
 */
export type BenchTrigger =
  | { kind: 'manual' }
  | { kind: 'full' }
  | { kind: 'changed'; agents: string[] }
  | { kind: 'practice'; agent: string; practiceId: string }
  | { kind: 'prompt-change'; agent: string; changeId: string }

export interface BenchSettings {
  enabled: boolean
  idleMinutes: number
  fullEveryHours: number
}

export interface BenchState {
  benched: Record<string, string>
  lastFullAt?: string
}

export async function getBench(): Promise<{ settings: BenchSettings; state: BenchState }> {
  const { data } = await api.get<{ settings: BenchSettings; state: BenchState }>('/evals/level2/bench')
  return data
}

export async function saveBench(settings: BenchSettings): Promise<BenchSettings> {
  const { data } = await api.put<{ settings: BenchSettings }>('/evals/level2/bench', settings)
  return data.settings
}

export interface ScenarioOutcome {
  scenarioId: string
  before?: boolean
  after: boolean
}

interface ChangeBase {
  id: string
  agent: string
  why: string
  status: 'proposed' | 'comparing' | 'ready' | 'accepted' | 'handed-over' | 'dismissed'
  createdAt: string
}

export interface PromptChange extends ChangeBase {
  kind: 'prompt'
  prompt: string
  currentPrompt: string
  comparison?: { runId?: string; checkedAt: string; scenarios: ScenarioOutcome[]; better: string[]; worse: string[]; unchecked?: boolean }
}

export interface ProcedureRequest extends ChangeBase {
  kind: 'procedure'
  procedure: string
  request: string
  conversationId?: string
}

export type AgentChange = PromptChange | ProcedureRequest

export async function listChanges(): Promise<AgentChange[]> {
  const { data } = await api.get<{ changes: AgentChange[] }>('/evals/level2/changes')
  return data.changes
}

export async function acceptChange(id: string, prompt?: string): Promise<AgentChange> {
  const { data } = await api.post<{ change: AgentChange }>(`/evals/level2/changes/${encodeURIComponent(id)}/accept`, prompt ? { prompt } : {})
  return data.change
}

export async function handOverChange(id: string): Promise<ProcedureRequest> {
  const { data } = await api.post<{ change: ProcedureRequest }>(`/evals/level2/changes/${encodeURIComponent(id)}/hand-over`, {})
  return data.change
}

export async function dismissChange(id: string): Promise<void> {
  await api.post(`/evals/level2/changes/${encodeURIComponent(id)}/dismiss`, {})
}

export interface Practice {
  id: string
  agent?: string
  title: string
  text: string
  status?: 'active' | 'pending_review' | 'trial'
  trial?: { checkedAt: string; runId?: string; scenarios?: string[]; regressions?: string[]; unchecked?: boolean }
  createdAt: string
  updatedAt: string
}

export async function listPractices(): Promise<Practice[]> {
  const { data } = await api.get<{ practices: Practice[] }>('/evals/level2/practices')
  return data.practices
}

export async function makePracticeLive(id: string): Promise<void> {
  await api.post(`/evals/level2/practices/${encodeURIComponent(id)}/live`, {})
}

export async function retirePractice(id: string): Promise<void> {
  await api.post(`/evals/level2/practices/${encodeURIComponent(id)}/retire`, {})
}

export interface ScenarioProposal {
  id: string
  scenario: Scenario
  why: string
  status: 'proposed' | 'accepted' | 'dismissed'
  proposedBy?: string
  createdAt: string
  decidedAt?: string
}

export async function listProposals(): Promise<ScenarioProposal[]> {
  const { data } = await api.get<{ proposals: ScenarioProposal[] }>('/evals/level2/proposals')
  return data.proposals
}

export async function acceptProposal(id: string, scenario?: Scenario): Promise<Scenario> {
  const { data } = await api.post<{ scenario: Scenario }>(`/evals/level2/proposals/${encodeURIComponent(id)}/accept`, scenario ? { scenario } : {})
  return data.scenario
}

export async function dismissProposal(id: string): Promise<void> {
  await api.post(`/evals/level2/proposals/${encodeURIComponent(id)}/dismiss`, {})
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
