import { API_BASE, api } from '../../../api/client'

export interface ArtifactStorage {
  minio: boolean
}

export const artifactKeys = {
  storage: ['artifact-storage'] as const,
}

export const getArtifactStorage = (): Promise<ArtifactStorage> =>
  api.get<ArtifactStorage>('/artifacts/storage').then((r) => r.data)

export const ARTIFACT_LINK = /\/api\/artifacts\/[0-9a-f-]{8,}/

export const artifactUrl = (id: string): string => `${API_BASE}/artifacts/${encodeURIComponent(id)}`

export const withArtifactAddresses = (text: string): string => text.replace(/\(\/api\/artifacts\//g, `(${API_BASE}/artifacts/`)
