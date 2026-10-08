import type { ProjectRemovalPreview, ProjectRemovalState } from '../types/project-removal'
import { api } from './client'

export const projectKeys = {
  list: () => ['projects'] as const,
  runs: (id: string | null) => ['project-runs', id] as const,
  log: (runId: string | null) => ['logs', 'pipeline', runId] as const,
  removal: (id: string) => ['projects', id, 'removal'] as const,
}

export const listProjects = <T,>(): Promise<T[]> =>
  api.get<T[]>('/projects').then((r) => r.data)

export const createProject = (body: unknown) => api.post('/projects', body).then((r) => r.data)

export const patchProject = (id: string, body: unknown) => api.patch(`/projects/${id}`, body).then((r) => r.data)

export const listProjectRuns = <T,>(id: string): Promise<T[]> =>
  api.get<T[]>(`/projects/${id}/runs`).then((r) => r.data)

export const getPipelineLog = (runId: string): Promise<{ content: string }> =>
  api.get<{ content: string }>(`/logs/pipeline/${runId}`).then((r) => r.data)

export const promoteRun = (projectId: string, runId: string, body?: unknown) =>
  api.post(`/projects/${projectId}/runs/${runId}/promote`, body ?? {}).then((r) => r.data)

export const getProjectRemoval = (id: string): Promise<ProjectRemovalPreview> =>
  api.get<ProjectRemovalPreview>(`/projects/${encodeURIComponent(id)}/removal`).then((r) => r.data)

export const deleteProject = (id: string, confirm: string): Promise<ProjectRemovalState> =>
  api.delete<{ state: ProjectRemovalState }>(`/projects/${encodeURIComponent(id)}`, { data: { confirm } }).then((r) => r.data.state)
