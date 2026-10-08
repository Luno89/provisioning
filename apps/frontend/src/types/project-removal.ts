/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `ProjectRemovalPreview` and `ProjectRemovalStep` in apps/backend/src/lib/project-removal.ts,
 * `ProjectRemovalState` in apps/backend/src/services/ProjectRemovalService.ts.
 */
export type ProjectRemovalStep = 'workflows' | 'workspaces' | 'secrets' | 'repositories' | 'records'

export type ProjectRemovalState =
  | { state: 'running'; done: ProjectRemovalStep[] }
  | { state: 'failed'; reason: string }
  | { state: 'finished' }
  | { state: 'none' }

export interface ProjectRemovalPreview {
  name: string
  repository?: string
  trees: { id: string; name: string; leaves: number; conversations: number }[]
  keptConversations: number
  builds: number
  blockers: string[]
  state: ProjectRemovalState
}
