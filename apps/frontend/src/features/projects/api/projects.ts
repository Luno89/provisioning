import type { DeletedProject, ProjectDeletion, ProjectDeletionMode, ProjectRemovalPreview, RestoredProject } from '../types/project-removal'
import { api } from '../../../api/client'

export const projectKeys = {
  list: () => ['projects'] as const,
  runs: (id: string | null) => ['project-runs', id] as const,
  log: (runId: string | null) => ['logs', 'pipeline', runId] as const,
  removal: (id: string) => ['projects', id, 'removal'] as const,
  deletion: (id: string) => ['project-deletion', id] as const,
  deleted: () => ['projects-deleted'] as const,
}

export const listProjects = <T,>(): Promise<T[]> =>
  api.get<T[]>('/projects').then((r) => r.data)

export const createProject = (body: unknown): Promise<{ id: string }> => api.post<{ id: string }>('/projects', body).then((r) => r.data)

export const patchProject = (id: string, body: unknown) => api.patch<unknown>(`/projects/${id}`, body).then((r) => r.data)

export const listProjectRuns = <T,>(id: string): Promise<T[]> =>
  api.get<T[]>(`/projects/${id}/runs`).then((r) => r.data)

export const getPipelineLog = (runId: string): Promise<{ content: string }> =>
  api.get<{ content: string }>(`/logs/pipeline/${runId}`).then((r) => r.data)

export const promoteRun = (projectId: string, runId: string, body?: unknown) =>
  api.post<unknown>(`/projects/${projectId}/runs/${runId}/promote`, body ?? {}).then((r) => r.data)

export const getProjectRemoval = (id: string): Promise<ProjectRemovalPreview> =>
  api.get<ProjectRemovalPreview>(`/projects/${encodeURIComponent(id)}/removal`).then((r) => r.data)

export const listDeletedProjects = (): Promise<DeletedProject[]> =>
  api.get<DeletedProject[]>('/projects/deleted').then((r) => r.data)

export const restoreProject = (id: string): Promise<RestoredProject> =>
  api.post<RestoredProject>(`/projects/${encodeURIComponent(id)}/restore`).then((r) => r.data)

export const purgeProject = (id: string, confirm: string): Promise<void> =>
  api.post(`/projects/${encodeURIComponent(id)}/purge`, { confirm }).then(() => undefined)

export const deleteProject =(id: string, confirm: string, mode: ProjectDeletionMode): Promise<ProjectDeletion> =>
  api.delete<{ deletion: ProjectDeletion }>(`/projects/${encodeURIComponent(id)}`, { data: { confirm, mode } }).then((r) => r.data.deletion)
