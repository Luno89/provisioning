/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `FileServer`, `FilePlace` and `FileEntry` in apps/backend/src/lib/file-places.ts,
 * `PlaceState` in apps/backend/src/services/FileService.ts, `MessageAttachment` in apps/backend/src/lib/attachments.ts.
 */
export type FileServerKind = 'minio' | 'nextcloud'

export interface FileServer {
  kind: FileServerKind
  deploymentId: string
  name: string
  clusterId: string
}

export interface FilePlace {
  kind: FileServerKind
  deploymentId: string
  folder: string
}

export interface StoredFile {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  modified?: string
}

export type PlaceState =
  | { state: 'ready'; place: FilePlace; server: FileServer; chosen: boolean }
  | { state: 'starting'; place: FilePlace; server: string }
  | { state: 'gone'; place: FilePlace; why: string }
  | { state: 'none' }

export interface MessageAttachment {
  name: string
  path: string
  size?: number
  type?: string
  project?: { id: string; name: string }
}

export type FileScope = { kind: 'project'; projectId: string } | { kind: 'mine' }
