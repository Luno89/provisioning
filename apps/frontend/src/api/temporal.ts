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
  owner?: string
}

export type WorkflowScope = 'mine' | 'all'

export interface WorkflowList {
  workflows: WorkflowSummary[]
  all: boolean
  canSeeAll: boolean
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
  workflows: (scope?: WorkflowScope) => ['temporal-workflows', scope ?? 'default'] as const,
  workflowCount: (scope?: WorkflowScope) => ['temporal-counts', scope ?? 'default'] as const,
  workflow: (id: string) => ['temporal-workflow', id] as const,
  everyList: () => ['temporal-workflows'] as const,
  everyCount: () => ['temporal-counts'] as const,
}

export const getTemporalStatus = (): Promise<TemporalStatus> =>
  api.get<TemporalStatus>('/temporal/status').then((r) => r.data)

export const listWorkflows = (pageSize = 50, scope?: WorkflowScope): Promise<WorkflowList> =>
  api.get<Partial<WorkflowList>>('/temporal/workflows', { params: { pageSize, ...(scope ? { scope } : {}) } })
    .then((r) => ({ workflows: r.data.workflows ?? [], all: r.data.all === true, canSeeAll: r.data.canSeeAll === true }))

export const getWorkflowCount = (scope?: WorkflowScope): Promise<WorkflowCounts> =>
  api.get<WorkflowCounts>('/temporal/workflows/count', { params: scope ? { scope } : {} }).then((r) => r.data)

export const getWorkflow = (id: string): Promise<WorkflowSummary | null> =>
  api.get<{ workflow?: WorkflowSummary }>(`/temporal/workflows/${encodeURIComponent(id)}`)
    .then((r) => r.data.workflow ?? null)

export const cancelWorkflow = (id: string): Promise<void> =>
  api.post(`/temporal/workflows/${encodeURIComponent(id)}/cancel`, {}).then(() => undefined)
