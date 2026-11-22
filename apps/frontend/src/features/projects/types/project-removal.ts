/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `ProjectRemovalPreview` in apps/backend/src/projects/lib/project-removal.ts, `ProjectRemoval` in
 * apps/backend/src/platform/lib/types.ts, `DeletionProgress` and its parts in apps/backend/src/projects/lib/project-deletion.ts,
 * `ProjectDeletionEvent` and `PROJECT_DELETION` in apps/backend/src/projects/services/ProjectDeletionNotices.ts, `DeletedProject` and what
 * `ProjectRemovalService.restore` answers in apps/backend/src/projects/services/ProjectRemovalService.ts, `ARCHIVE_DAYS` in apps/backend/src/projects/lib/project-archive.ts.
 */
export const PROJECT_DELETION = 'project-deletion'

export const ARCHIVE_DAYS = 90

export type ProjectDeletionMode = 'archive' | 'permanent'

export type WorkStopState = 'stopping' | 'stopped' | 'restarting' | 'restarted' | 'gone'

export interface StoppingWork {
  workflowId: string
  type: string
  startedAt: string
  state: WorkStopState
  what?: string
  worker?: string
  killed?: string[]
}

export type DeletionPart = 'projects' | 'apps' | 'workspaces' | 'secrets' | 'repositories' | 'files' | 'records'

export interface PartProgress {
  state: 'deleting' | 'deleted'
  left?: number
  deleted: number
}

export interface DeletionProgress {
  seq: number
  phase: 'deleting' | 'archived' | 'deleted'
  work: StoppingWork[]
  parts: Partial<Record<DeletionPart, PartProgress>>
  problem?: string
  keptUntil?: string
  down?: ServiceDown[]
}

export interface ServiceDown {
  step: string
  dependency: string
  name: string
  since: string
  reason: string
}

export interface ProjectDeletion {
  startedAt: string
  requestedBy: string
  mode: ProjectDeletionMode
  phase: 'deleting' | 'archived'
  progress?: DeletionProgress
}

export interface ProjectDeletionEvent {
  projectId: string
  progress: DeletionProgress
}

export interface ProjectRemovalPreview {
  name: string
  repository?: string
  trees: { id: string; name: string; leaves: number; conversations: number }[]
  keptConversations: number
  builds: number
  apps: string[]
  files?: { server: string; folder: string }
  deletion?: ProjectDeletion
}

export interface RestoredProject {
  name: string
  renamed: boolean
  secrets: string[]
}

export interface DeletedProject {
  id: string
  name: string
  deletedAt: string
  keptUntil: string | undefined
}
