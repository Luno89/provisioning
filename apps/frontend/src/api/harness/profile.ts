import { api, API_BASE } from '../client'
import type { HarnessProfile, HarnessConfig } from '@koala/harness-types'

export const profileKeys = {
  profile: () => ['harness-profile'] as const,
  preview: (params?: unknown) => ['harness-profile-preview', params] as const,
  config: () => ['harness-config'] as const,
}

export const getProfile = (): Promise<HarnessProfile> =>
  api.get<HarnessProfile>('/harness/profile').then((r) => r.data)

export const saveProfile = (body: unknown): Promise<HarnessProfile> =>
  api.put<HarnessProfile>('/harness/profile', body).then((r) => r.data)

export const resetProfile = () => api.delete('/harness/profile').then((r) => r.data)

export const previewProfile = (params?: Record<string, unknown>) =>
  api.get('/harness/profile/preview', { params }).then((r) => r.data)

export const promoteVariant = (experimentId: string, label: string) =>
  api.post('/harness/profile/promote', { experimentId, label }).then((r) => r.data)

export const getPromotionStanding = (params: { experimentId: string; label: string }) =>
  api.get('/harness/profile/promote', { params }).then((r) => r.data)

export const harnessExportUrl = (): string => `${API_BASE}/harness/export`

export const getConfig = (): Promise<HarnessConfig> =>
  api.get<HarnessConfig>('/harness/config').then((r) => r.data)

export interface ImportResult {
  created?: string[]
  failed?: string[]
  rejected?: string[]
}

export const importHarnessConfig = (doc: unknown): Promise<ImportResult> =>
  api.post<ImportResult>('/harness/import', doc).then((r) => r.data)
