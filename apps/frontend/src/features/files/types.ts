/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `FileServer`, `FilePlace` and `FileEntry` in apps/backend/src/files/lib/file-places.ts,
 * `PlaceState` in apps/backend/src/files/services/FileService.ts, `MessageAttachment` in apps/backend/src/engine/lib/attachments.ts,
 * `FileShare` and `SHARE_DAYS` in apps/backend/src/files/lib/file-shares.ts.
 */
export type FileServerKind = 'minio'

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

export type FileScope = { kind: 'project'; projectId: string } | { kind: 'hub'; projectId: string } | { kind: 'mine' }

export interface FileShare {
  id: string
  ownerId: string
  projectId?: string
  path: string
  name: string
  createdAt: string
  expiresAt: string
}

export const SHARE_DAYS = [1, 7, 30] as const
export type ShareDays = typeof SHARE_DAYS[number]
