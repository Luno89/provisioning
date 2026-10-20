import { api } from './client'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `OdooRelease` and `ReleaseState` in apps/backend/src/lib/odoo-release.ts,
 * `RollBackOffer` in apps/backend/src/services/OdooReleaseService.ts,
 * `ReleaseE2E` in apps/backend/src/lib/release-e2e.ts, `E2ETest` in apps/backend/src/lib/e2e.ts,
 * `ReleaseChanges` in apps/backend/src/lib/release-compare.ts,
 * `ReleaseFile` in apps/backend/src/lib/file-changes.ts, `ReleaseFiles` and `AGAIN_FROM` in apps/backend/src/services/OdooReleaseService.ts.
 */
export type ReleaseState = 'queued' | 'preparing' | 'preview' | 'cutting-over' | 'live' | 'rolling-back' | 'rolled-back' | 'discarded' | 'failed' | 'superseded'

export interface E2ETest {
  title: string
  file: string
  status: 'passed' | 'failed' | 'flaky' | 'skipped'
  durationMs: number
  error?: string
  page?: string
}

export interface ReleaseE2E {
  state: 'running' | 'passed' | 'failed' | 'unavailable' | 'stopped'
  summary?: string
  tests?: E2ETest[]
  artifacts?: { id: string; name: string }[]
  notKept?: string[]
  reason?: string
  e2e?: ReleaseE2E
  startedAt: string
  finishedAt?: string
}

export interface ReleaseChanges {
  checkedAt: string
  tables: { table: string; rows: number }[]
  columns: { table: string; column: string; filled: number }[]
  retyped: { table: string; column: string; from: string; to: string; filled: number; keptIn?: string }[]
  items: { kind: string; key: string; name: string; state: 'kept' | 'reset' | 'switched-off' | 'gone' }[]
  losing: boolean
  lost: string[]
}

export interface OdooRelease {
  id: string
  projectId: string
  pipelineRunId: string
  commit: string
  image: string
  slot?: 'a' | 'b'
  state: ReleaseState
  host: string
  previewHost?: string
  reason?: string
  e2e?: ReleaseE2E
  changes?: ReleaseChanges
  liveAt?: string
  again?: string
  restoredAt?: string
  startedAt: string
  updatedAt: string
}

export interface ReleaseFile {
  path: string
  from?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  added: number
  removed: number
  binary: boolean
  patch: string
  inApp: boolean
}

export interface ReleaseFiles {
  against?: { releaseId: string; commit: string; state: ReleaseState }
  files: ReleaseFile[]
  note?: string
}

export const AGAIN_FROM: readonly ReleaseState[] = ['preview', 'failed', 'discarded', 'superseded', 'rolled-back']

export interface RollBackOffer {
  from: string
  to: string
  commit: string
  liveSince?: string
}

export interface ReleaseList {
  releases: OdooRelease[]
  addresses: { live?: string; preview?: string }
  rollBack?: RollBackOffer
}

export const releaseKeys = {
  list: (projectId: string) => ['project-releases', projectId] as const,
  files: (projectId: string, releaseId: string) => ['project-release-files', projectId, releaseId] as const,
  signIn: (projectId: string) => ['project-sign-in', projectId] as const,
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `SignIn` in apps/backend/src/services/ProjectSecretsService.ts.
 */
export interface SignIn {
  login: string
  password: string
  describe: string
}

export const getSignIn = (projectId: string): Promise<SignIn[]> =>
  api.get<{ signIns: SignIn[] }>(`/projects/${encodeURIComponent(projectId)}/sign-in`).then((r) => r.data.signIns)

export const listReleases = (projectId: string): Promise<ReleaseList> =>
  api.get<ReleaseList>(`/projects/${encodeURIComponent(projectId)}/releases`).then((r) => r.data)

export const decideRelease = (projectId: string, releaseId: string, decision: 'cut-over' | 'discard', confirm = false): Promise<void> =>
  api.post(`/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}/${decision}`, confirm ? { confirm } : {}).then(() => undefined)

export const rollBackRelease = (projectId: string, releaseId: string): Promise<void> =>
  api.post(`/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}/roll-back`, {}).then(() => undefined)

export const retestRelease = (projectId: string, releaseId: string): Promise<void> =>
  api.post(`/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}/retest`, {}).then(() => undefined)

export const releaseFiles = (projectId: string, releaseId: string): Promise<ReleaseFiles> =>
  api.get<ReleaseFiles>(`/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}/files`).then((r) => r.data)

export const releaseAgain = (projectId: string, releaseId: string): Promise<void> =>
  api.post(`/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}/again`, {}).then(() => undefined)
