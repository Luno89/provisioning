import { api } from './client'

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

export const getPipelineLog = (runId: string): Promise<{ content: string }> =>
  api.get<{ content: string }>(`/logs/pipeline/${runId}`).then((r) => r.data)

export const promoteRun = (projectId: string, runId: string, body?: unknown) =>
  api.post(`/projects/${projectId}/runs/${runId}/promote`, body ?? {}).then((r) => r.data)
