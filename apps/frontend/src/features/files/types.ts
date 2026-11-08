/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `FileEntry` in apps/backend/src/files/lib/file-places.ts, `MessageAttachment` in apps/backend/src/engine/lib/attachments.ts,
 * `FileShare` and `SHARE_DAYS` in apps/backend/src/files/lib/file-shares.ts.
 */
export interface StoredFile {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  modified?: string
  id?: string
}

export interface MessageAttachment {
  fileId?: string
  name: string
  path?: string
  size?: number
  type?: string
  project?: { id: string; name: string }
}

export type FileScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'hub'; projectId: string }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'mine' }

export type ShareableScope = Exclude<FileScope, { kind: 'hub' }>

export interface FileShare {
  id: string
  token: string
  ownerId: string
  projectId?: string
  fileId?: string
  path: string
  name: string
  createdAt: string
  expiresAt: string
}

export const SHARE_DAYS = [1, 7, 30] as const
export type ShareDays = typeof SHARE_DAYS[number]
