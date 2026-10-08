import { api } from './client'

export interface ArtifactStorage {
  minio: boolean
}

export const artifactKeys = {
  storage: ['artifact-storage'] as const,
}

export const getArtifactStorage = (): Promise<ArtifactStorage> =>
  api.get<ArtifactStorage>('/artifacts/storage').then((r) => r.data)

export const ARTIFACT_LINK = /\/api\/artifacts\/[0-9a-f-]{8,}/
