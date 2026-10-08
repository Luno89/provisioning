import { api } from './client'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `OdooRelease` and `ReleaseState` in apps/backend/src/lib/odoo-release.ts.
 */
export type ReleaseState = 'preparing' | 'preview' | 'cutting-over' | 'live' | 'discarded' | 'failed' | 'superseded'

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
  startedAt: string
  updatedAt: string
}

export interface ReleaseList {
  releases: OdooRelease[]
  addresses: { live?: string; preview?: string }
}

export const releaseKeys = {
  list: (projectId: string) => ['project-releases', projectId] as const,
}

export const listReleases = (projectId: string): Promise<ReleaseList> =>
  api.get<ReleaseList>(`/projects/${encodeURIComponent(projectId)}/releases`).then((r) => r.data)

export const decideRelease = (projectId: string, releaseId: string, decision: 'cut-over' | 'discard'): Promise<void> =>
  api.post(`/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}/${decision}`, {}).then(() => undefined)
