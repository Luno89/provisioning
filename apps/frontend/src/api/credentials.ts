import { api } from './client'
import type {
  ProviderStatus, GoogleDriveStatus, ValidationResult, BackupResult,
} from '../types/credentials'

export const credentialKeys = {
  all: ['credentials'] as const,
  list: () => [...credentialKeys.all, 'list'] as const,
  one: (provider: string) => [...credentialKeys.all, provider] as const,
}

export const listProviders = (): Promise<ProviderStatus[]> =>
  api.get<{ providers: ProviderStatus[] }>('/credentials').then((r) => r.data.providers)

export const getCredentials = (provider: string): Promise<Record<string, string> | null> =>
  api.get<{ credentials: Record<string, string> | null }>(`/credentials/${provider}`)
    .then((r) => r.data.credentials)

export const saveCredentials = (provider: string, values: Record<string, string>): Promise<void> =>
  api.put(`/credentials/${provider}`, values).then(() => undefined)

export const deleteCredentials = (provider: string): Promise<void> =>
  api.delete(`/credentials/${provider}`).then(() => undefined)

export const validateCredentials = (
  provider: string,
  values: Record<string, string> = {},
): Promise<ValidationResult> =>
  api.post<ValidationResult>(`/credentials/validate/${provider}`, values).then((r) => r.data)

export const getDriveStatus = (): Promise<GoogleDriveStatus> =>
  api.get<{ credentials: GoogleDriveStatus | null }>('/credentials/googledrive')
    .then((r) => r.data.credentials ?? {})

export const driveConnectUrl = (): string => `${api.defaults.baseURL}/credentials/googledrive/connect`

export const runBackup = (): Promise<BackupResult> =>
  api.post<BackupResult>('/backup/run').then((r) => r.data)

export const listLlmProviders = (): Promise<LlmProviderStatus[]> =>
  api.get<{ providers: LlmProviderStatus[] }>('/credentials/llm').then((r) => r.data.providers)

export const saveLlmCredentials = (data: {
  provider: string; apiKey?: string; baseUrl?: string; model?: string
}): Promise<{ endpoints: unknown[] }> =>
  api.post<{ endpoints: unknown[] }>('/credentials/llm', data).then((r) => r.data)

export const deleteLlmCredentials = (provider: string): Promise<{ removed: number }> =>
  api.delete(`/credentials/llm/${provider}`).then((r) => r.data)

export interface LlmProviderStatus {
  provider: string; label: string; baseUrl: string; docsUrl: string
  modelListAuth: boolean; icon: string; color: string
  modelCount: number; hasKey: boolean
}
