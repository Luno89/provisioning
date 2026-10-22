import { api } from '../../../api/client'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `Drift` in apps/backend/src/releases/services/CustomizationsService.ts, `InventoryItem` in apps/backend/src/releases/lib/release-compare.ts.
 */
export interface DriftItem {
  kind: string
  key: string
  name: string
}

export interface Drift {
  projectId: string
  project: string
  module: string
  items: DriftItem[]
}

export const customizationKeys = {
  drift: (projectId: string) => ['customizations', projectId] as const,
}

export const getDrift = (projectId: string): Promise<Drift> =>
  api.get<Drift>(`/projects/${encodeURIComponent(projectId)}/customizations`).then((r) => r.data)

export const proposeAdoption = (projectId: string, refs: string[], why: string): Promise<{ id: string }> =>
  api.post<{ id: string }>(`/projects/${encodeURIComponent(projectId)}/customizations/adopt`, { refs, why }).then((r) => r.data)
