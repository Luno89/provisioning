import { api } from './client'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `ProjectApp` and `ExposureMode` in apps/backend/src/lib/project-app.ts.
 */
export type ExposureMode = 'local' | 'public'

export interface AppAddresses {
  app?: string
  preview?: string
}

export interface ProjectApp {
  id: string
  name: string
  status: string
  local: AppAddresses
  public: AppAddresses
}

export const projectAppKeys = {
  of: (projectId: string) => ['project-app', projectId] as const,
}

export const getProjectApp = (projectId: string): Promise<ProjectApp | null> =>
  api.get<{ app: ProjectApp | null }>(`/projects/${encodeURIComponent(projectId)}/app`).then((r) => r.data.app)

export const openProjectApp = (projectId: string, mode: ExposureMode): Promise<ProjectApp> =>
  api.post<{ app: ProjectApp }>(`/projects/${encodeURIComponent(projectId)}/app/open`, { mode }).then((r) => r.data.app)
