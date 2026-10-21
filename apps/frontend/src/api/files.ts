import { api, API_BASE } from './client'
import type { FileScope, FileServer, PlaceState, StoredFile } from '../types/files'

export const FILE_TYPE_HEADER = 'X-File-Type'

const base = (scope: FileScope): string => (scope.kind === 'project' ? `/files/projects/${encodeURIComponent(scope.projectId)}` : '/files/mine')

export const fileKeys = {
  servers: ['files', 'servers'] as const,
  place: (projectId: string) => ['files', 'place', projectId] as const,
  list: (scope: FileScope, dir: string) => ['files', 'list', scope.kind === 'project' ? scope.projectId : 'mine', dir] as const,
  all: ['files'] as const,
}

export const getFileServers = (): Promise<{ servers: FileServer[]; defaultId?: string }> =>
  api.get<{ servers: FileServer[]; defaultId?: string }>('/files/servers').then((r) => r.data)

export const setDefaultFileServer = (deploymentId: string | null): Promise<{ defaultId?: string }> =>
  api.put<{ defaultId?: string }>('/files/default', { deploymentId }).then((r) => r.data)

export const getFilePlace = (projectId: string): Promise<PlaceState> =>
  api.get<PlaceState>(`/files/projects/${encodeURIComponent(projectId)}/place`).then((r) => r.data)

export const chooseFileServer = (projectId: string, deploymentId: string): Promise<PlaceState> =>
  api.put<PlaceState>(`/files/projects/${encodeURIComponent(projectId)}/place`, { deploymentId }).then((r) => r.data)

export const startProjectMinio = (projectId: string): Promise<PlaceState> =>
  api.post<PlaceState>(`/files/projects/${encodeURIComponent(projectId)}/minio`).then((r) => r.data)

export const listStoredFiles = (scope: FileScope, dir: string): Promise<StoredFile[]> =>
  api.get<StoredFile[]>(`${base(scope)}/list`, { params: { dir } }).then((r) => r.data)

export const uploadStoredFile = (scope: FileScope, path: string, file: Blob, onProgress?: (share: number) => void): Promise<{ path: string }> =>
  api.put<{ path: string }>(`${base(scope)}/content`, file, {
    params: { path },
    headers: { 'Content-Type': 'application/octet-stream', [FILE_TYPE_HEADER]: file.type || 'application/octet-stream' },
    timeout: 0,
    maxBodyLength: Infinity,
    onUploadProgress: (event) => onProgress?.(event.total ? event.loaded / event.total : 0),
  }).then((r) => r.data)

export const removeStoredFile = (scope: FileScope, path: string): Promise<{ path: string }> =>
  api.delete<{ path: string }>(`${base(scope)}/content`, { params: { path } }).then((r) => r.data)

export const moveStoredFile = (scope: FileScope, from: string, to: string): Promise<{ path: string }> =>
  api.post<{ path: string }>(`${base(scope)}/move`, { from, to }).then((r) => r.data)

export const storedFileUrl = (scope: FileScope, path: string, inline = false): string =>
  `${API_BASE}${base(scope)}/content?path=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`
