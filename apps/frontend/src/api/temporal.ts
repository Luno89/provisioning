import { api } from './client'

export interface WorkflowSummary {
  workflowId: string
  runId?: string
  type?: string
  status?: string
  startTime?: string
  closeTime?: string
  taskQueue?: string
  historyLength?: number
}

export interface WorkflowCounts {
  total: number
  running: number
  completed: number
  failed: number
  timedOut: number
}

export interface TemporalStatus {
  connected: boolean
  serverVersion?: string
}

export const temporalKeys = {
  status: () => ['temporal-status'] as const,
  workflows: () => ['temporal-workflows'] as const,
  workflowCount: () => ['temporal-counts'] as const,
  workflow: (id: string) => ['temporal-workflow', id] as const,
}

export const getTemporalStatus = (): Promise<TemporalStatus> =>
  api.get<TemporalStatus>('/temporal/status').then((r) => r.data)

export const listWorkflows = (pageSize = 50): Promise<WorkflowSummary[]> =>
  api.get<{ workflows?: WorkflowSummary[] }>('/temporal/workflows', { params: { pageSize } })
    .then((r) => r.data.workflows ?? [])

export const getWorkflowCount = (): Promise<WorkflowCounts> =>
  api.get<WorkflowCounts>('/temporal/workflows/count').then((r) => r.data)

export const getWorkflow = (id: string): Promise<WorkflowSummary | null> =>
  api.get<{ workflow?: WorkflowSummary }>(`/temporal/workflows/${encodeURIComponent(id)}`)
    .then((r) => r.data.workflow ?? null)
