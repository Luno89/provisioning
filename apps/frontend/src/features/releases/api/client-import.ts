import { api } from '../../../api/client'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `ClientImport` in apps/backend/src/releases/lib/client-import.ts, `ImportView` in apps/backend/src/releases/services/ClientImportService.ts.
 */
export type ImportMode = 'copy' | 'live'

export interface ClientImport {
  state: 'awaited' | 'uploading' | 'uploaded' | 'refused' | 'importing' | 'imported' | 'failed'
  mode: ImportMode
  bytes: number
  version?: string
  modules?: string[]
  missing?: string[]
  reason?: string
  at: string
}

export interface ImportView {
  import?: ClientImport
  open: boolean
  why?: string
}

export const clientImportKeys = {
  view: (projectId: string) => ['client-import', projectId] as const,
}

export const getImport = (projectId: string): Promise<ImportView> =>
  api.get<ImportView>(`/projects/${encodeURIComponent(projectId)}/import`).then((r) => r.data)

export const uploadImport = (projectId: string, file: File, mode: ImportMode, onProgress: (fraction: number) => void): Promise<ClientImport> =>
  api.put<ClientImport>(`/projects/${encodeURIComponent(projectId)}/import`, file, {
    params: { mode },
    headers: { 'Content-Type': 'application/zip' },
    timeout: 0,
    maxBodyLength: Infinity,
    onUploadProgress: (event) => onProgress(event.total ? event.loaded / event.total : 0),
  }).then((r) => r.data)

export const startFresh = (projectId: string): Promise<{ released: boolean }> =>
  api.delete<{ released: boolean }>(`/projects/${encodeURIComponent(projectId)}/import`).then((r) => r.data)
