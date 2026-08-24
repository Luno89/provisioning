import { api } from './client'

/** Git-backed projects and their pipeline runs. */

export const projectKeys = {
  list: () => ['projects'] as const,
  runs: (id: string) => ['project-runs', id] as const,
}

export const listProjects = () => api.get('/projects').then((r) => r.data)
export const createProject = (body: unknown) => api.post('/projects', body).then((r) => r.data)
export const listProjectRuns = (id: string) =>
  api.get(`/projects/${id}/runs`).then((r) => r.data)

/** Promotes a build to a deployment. The only mutating verb on a run. */
export const promoteRun = (projectId: string, runId: string, body?: unknown) =>
  api.post(`/projects/${projectId}/runs/${runId}/promote`, body ?? {}).then((r) => r.data)
