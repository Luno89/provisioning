import { api } from './client'

export interface AgentInputSchema {
  type?: string
  properties?: Record<string, { type?: string; description?: string }>
  required?: string[]
}

export interface EngineAgent {
  slug: string
  name: string
  description: string
  loop: string
  tools: string[]
  canDelegateTo: string[]
  inputs: AgentInputSchema | null
  mine: boolean
}

/** What to call the one thing an agent needs to be given, and what to label the box. */
export function primaryInput(agent: EngineAgent | undefined): { field: string; label: string } {
  const properties = agent?.inputs?.properties ?? {}
  const field = agent?.inputs?.required?.[0] ?? Object.keys(properties)[0] ?? 'message'
  const labels: Record<string, string> = {
    goal: 'What do you want built?',
    question: 'What do you want to know?',
    task: 'What should it do?',
    message: 'What do you want it to do?',
  }
  return { field, label: labels[field] ?? `${field}?` }
}

export interface StartedRun {
  runId: string
  agentSlug: string
  loopId: string
}

export type EngineEvent =
  | { type: 'run.started'; runId: string; at: string; agentId: string; loopId: string; parentRunId?: string }
  | { type: 'run.finished'; runId: string; at: string; outcome: string; reason?: string }
  | { type: 'node.entered'; runId: string; at: string; nodeId: string }
  | { type: 'node.exited'; runId: string; at: string; nodeId: string; via?: string }
  | { type: 'model.requested'; runId: string; at: string; nodeId: string; toolNames: string[] }
  | { type: 'thinking'; runId: string; at: string; nodeId: string; delta: string }
  | { type: 'content'; runId: string; at: string; nodeId: string; delta: string }
  | { type: 'tool.called'; runId: string; at: string; nodeId: string; callId: string; name: string; args: string }
  | { type: 'tool.result'; runId: string; at: string; nodeId: string; callId: string; ok: boolean; digest: string }
  | { type: 'usage'; runId: string; at: string; nodeId: string; usage: Record<string, unknown> }
  | { type: 'notice'; runId: string; at: string; level: 'info' | 'warn'; message: string }
  | { type: 'interrupted'; runId: string; at: string; reason: string }

export const ENGINE_EVENT_CHANNEL = 'engine-event'

export type TaskStatus = 'proposed' | 'accepted' | 'running' | 'done' | 'failed' | 'dropped'

export interface EngineTask {
  id: string
  title: string
  intent?: string
  doneMeans: string
  status: TaskStatus
  dependsOn: string[]
  agent?: string
  evidence?: string
  checks?: { command?: string; expects?: string[] }
  ready: boolean
  waitingOn: { id: string; title: string; status: TaskStatus }[]
}

export const engineKeys = {
  agents: () => ['engine', 'agents'] as const,
  tasks: () => ['engine', 'tasks'] as const,
}

export async function listTasks(): Promise<EngineTask[]> {
  const { data } = await api.get<EngineTask[]>('/engine/tasks')
  return data
}

export async function acceptTask(taskId: string): Promise<void> {
  await api.post(`/engine/tasks/${taskId}/accept`, {})
}

export async function dropTask(taskId: string): Promise<void> {
  await api.post(`/engine/tasks/${taskId}/drop`, {})
}

export async function listEngineAgents(): Promise<EngineAgent[]> {
  const { data } = await api.get<EngineAgent[]>('/engine/agents')
  return data
}

export async function startRun(input: {
  agent: string
  message: string
  inputs?: Record<string, unknown>
  conversationId?: string
}): Promise<StartedRun> {
  const { data } = await api.post<StartedRun>('/engine/runs', input)
  return data
}

export async function answerRun(runId: string, nodeId: string, value: unknown): Promise<void> {
  await api.post(`/engine/runs/${runId}/answer`, { nodeId, value })
}

export async function approveRunCall(
  runId: string,
  input: { callId: string; allowed: boolean; forRun?: boolean },
): Promise<void> {
  await api.post(`/engine/runs/${runId}/approve`, input)
}

export async function cancelRun(runId: string): Promise<void> {
  await api.post(`/engine/runs/${runId}/cancel`, {})
}
