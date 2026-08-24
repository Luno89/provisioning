import { api } from './client'

/**
 * Temporal, read-only from the UI.
 *
 * Deliberately no terminate/cancel here even though `routes/temporal.ts` exposes them: ending a
 * workflow mid-provision leaves a half-built cluster that Mongo still believes is coming up, and
 * the reconciliation loop then has to guess. The E2E monitor script does it; a user should not,
 * from a panel whose purpose is to look.
 */

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

/** Counts by status, for the badges. Read off the live route rather than invented. */
export interface WorkflowCounts {
  total: number
  running: number
  completed: number
  failed: number
  timedOut: number
}

export interface TemporalStatus {
  connected: boolean
  /**
   * Absent when the server is reachable but did not report one — the route sends
   * `{ connected, serverVersion: undefined }` rather than omitting the key, so the panel has to
   * render the unknown case. Written from `routes/temporal.ts`, not guessed.
   */
  serverVersion?: string
}

export const temporalKeys = {
  status: () => ['temporal-status'] as const,
  workflows: () => ['temporal-workflows'] as const,
  workflowCount: () => ['temporal-counts'] as const,
  workflow: (id: string) => ['temporal-workflow', id] as const,
}

/** Whether Temporal is reachable at all — it is optional, and the backend runs without it. */
export const getTemporalStatus = (): Promise<TemporalStatus> =>
  api.get<TemporalStatus>('/temporal/status').then((r) => r.data)

/**
 * Unwraps `{ workflows: [...] }` here rather than at the call site.
 *
 * The panel reached into `r.data.workflows || []` itself, which is the response ENVELOPE — a
 * screen that knows the wire shape is a screen that breaks when the route adds a field beside it.
 */
export const listWorkflows = (pageSize = 50): Promise<WorkflowSummary[]> =>
  api.get<{ workflows?: WorkflowSummary[] }>('/temporal/workflows', { params: { pageSize } })
    .then((r) => r.data.workflows ?? [])

/** Just the count, for the badge — the full list is a much larger response. */
export const getWorkflowCount = (): Promise<WorkflowCounts> =>
  api.get<WorkflowCounts>('/temporal/workflows/count').then((r) => r.data)

/** Encodes the id: a workflow id contains slashes and colons often enough to matter. */
export const getWorkflow = (id: string): Promise<WorkflowSummary | null> =>
  api.get<{ workflow?: WorkflowSummary }>(`/temporal/workflows/${encodeURIComponent(id)}`)
    .then((r) => r.data.workflow ?? null)
