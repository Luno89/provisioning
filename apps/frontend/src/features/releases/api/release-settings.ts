import { api } from '../../../api/client'

export const releaseSettingKeys = {
  options: () => ['release-options'] as const,
  project: (projectId: string) => ['project-release', projectId] as const,
}

export interface ReleaseHow {
  agent: string
  app?: string
}

export interface ReleaseAgent {
  slug: string
  name: string
  description?: string
  needsApp: boolean
}

export interface ReleaseOptions {
  agents: ReleaseAgent[]
  apps: { id: string; title: string }[]
}

export interface ProjectRelease {
  how: ReleaseHow
  from: 'project' | 'tree type' | 'repository'
}

export const getReleaseOptions = (): Promise<ReleaseOptions> =>
  api.get<ReleaseOptions>('/release-settings/options').then((r) => r.data)

export const getProjectRelease = (projectId: string): Promise<ProjectRelease> =>
  api.get<ProjectRelease>(`/release-settings/projects/${projectId}`).then((r) => r.data)

export const setProjectRelease = (projectId: string, release: ReleaseHow | null): Promise<ProjectRelease> =>
  api.put<ProjectRelease>(`/release-settings/projects/${projectId}`, { release }).then((r) => r.data)
