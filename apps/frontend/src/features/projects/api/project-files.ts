import { api } from '../../../api/client'
import type { StoryDrop } from '../lib/leaf-types'
import { dropBody, type DropSettings, type DroppedCode } from '../lib/drop-body'

export interface RepoFileEntry {
  path: string
  name: string
  type: 'file' | 'dir'
  size?: number
}

export interface RepoFileContent {
  path: string
  content: string
  sha: string
}

export const projectFileKeys = {
  tree: (projectId: string, path: string) => ['project-files', projectId, 'tree', path] as const,
  content: (projectId: string, path: string) => ['project-files', projectId, 'content', path] as const,
}

export const listProjectFiles = (projectId: string, path = ''): Promise<{ path: string; entries: RepoFileEntry[] }> =>
  api.get<{ path: string; entries: RepoFileEntry[] }>(`/projects/${projectId}/files`, { params: { path } }).then((r) => r.data)

export const getProjectFileContent = (projectId: string, path: string): Promise<RepoFileContent> =>
  api.get<RepoFileContent>(`/projects/${projectId}/files/content`, { params: { path } }).then((r) => r.data)

export const saveProjectFileContent = (
  projectId: string,
  body: { path: string; content: string; sha: string; message?: string },
): Promise<{ sha: string }> =>
  api.put<{ sha: string }>(`/projects/${projectId}/files/content`, body).then((r) => r.data)

export const deleteProjectFile = (projectId: string, path: string, sha: string): Promise<{ success: boolean }> =>
  api.delete<{ success: boolean }>(`/projects/${projectId}/files/content`, { params: { path, sha } }).then((r) => r.data)

export const DROP_TYPE = 'application/vnd.koala.drop'

export type DropAnswer = { ok: true; paths: string[]; commit?: string } | { ok: true; drop: StoryDrop; said: string }

export const dropIntoRepository = (
  projectId: string,
  settings: DropSettings,
  files: readonly DroppedCode[],
  onProgress?: (share: number) => void,
): Promise<DropAnswer> =>
  api.post<DropAnswer>(`/projects/${projectId}/files/drop`, dropBody(settings, files), {
    headers: { 'Content-Type': DROP_TYPE },
    timeout: 0,
    maxBodyLength: Infinity,
    onUploadProgress: (event) => onProgress?.(event.total ? event.loaded / event.total : 0),
  }).then((r) => r.data)
