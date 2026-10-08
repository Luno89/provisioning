/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `RemovalWorkflowState` and `PersonEntry` in apps/backend/src/services/AccountRemovalService.ts,
 * `RemovalStep` in apps/backend/src/lib/account-removal.ts.
 */
export type RemovalStep = 'workflows' | 'workspaces' | 'secrets' | 'mesh' | 'repositories' | 'records'

export type RemovalState =
  | { state: 'running'; done: RemovalStep[] }
  | { state: 'failed'; reason: string }
  | { state: 'finished' }
  | { state: 'none' }

export interface PersonEntry {
  id: string
  email: string
  isAdmin: boolean
  createdAt: string
  removal?: { startedAt: string; requestedBy: string; state: RemovalState }
}

export interface RemovalPreview {
  email: string
  blockers: string[]
}

export interface RemovalRefusal {
  error: string
  blockers?: string[]
}
