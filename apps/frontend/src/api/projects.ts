import { api } from './client'

/** Git-backed projects and their pipeline runs. */

export const projectKeys = {
  list: () => ['projects'] as const,
  runs: (id: string | null) => ['project-runs', id] as const,
  log: (runId: string | null) => ['logs', 'pipeline', runId] as const,
}

export const listProjects = <T,>(): Promise<T[]> =>
  api.get<T[]>('/projects').then((r) => r.data)

export const createProject = (body: unknown) => api.post('/projects', body).then((r) => r.data)

export const listProjectRuns = <T,>(id: string): Promise<T[]> =>
  api.get<T[]>(`/projects/${id}/runs`).then((r) => r.data)

/**
 * A pipeline run's log, as it stands on disk.
 *
 * The socket stream appends to this rather than replacing it — same arrangement as the deployment
 * logs, so a run already in flight shows what it has done so far and then keeps going.
 */
export const getPipelineLog = (runId: string): Promise<{ content: string }> =>
  api.get<{ content: string }>(`/logs/pipeline/${runId}`).then((r) => r.data)

/** Promotes a build to a deployment. The only mutating verb on a run. */
export const promoteRun = (projectId: string, runId: string, body?: unknown) =>
  api.post(`/projects/${projectId}/runs/${runId}/promote`, body ?? {}).then((r) => r.data)
