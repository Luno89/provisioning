import { api } from './client'

/**
 * Temporal, read-only from the UI.
 *
 * Deliberately no terminate/cancel here even though `routes/temporal.ts` exposes them: ending a
 * workflow mid-provision leaves a half-built cluster that Mongo still believes is coming up, and
 * the reconciliation loop then has to guess. The E2E monitor script does it; a user should not,
 * from a panel whose purpose is to look.
 */

export const temporalKeys = {
  status: () => ['temporal-status'] as const,
  workflows: () => ['temporal-workflows'] as const,
  workflowCount: () => ['temporal-workflows', 'count'] as const,
  workflow: (id: string) => ['temporal-workflow', id] as const,
}

/** Whether Temporal is reachable at all — it is optional, and the backend runs without it. */
export const getTemporalStatus = () => api.get('/temporal/status').then((r) => r.data)

export const listWorkflows = () => api.get('/temporal/workflows').then((r) => r.data)

/** Just the count, for the badge — the full list is a much larger response. */
export const getWorkflowCount = () =>
  api.get('/temporal/workflows/count').then((r) => r.data)

export const getWorkflow = (id: string) =>
  api.get(`/temporal/workflows/${id}`).then((r) => r.data)
