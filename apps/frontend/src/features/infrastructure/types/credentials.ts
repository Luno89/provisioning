
export interface ProviderStatus {
  provider: string
  label: string
  configured: boolean
  source?: 'user' | 'env'
  summary?: Record<string, string>
}

export interface GoogleDriveStatus {
  email?: string
  backupPassword?: string
}

export interface ValidationResult {
  valid?: boolean
  message?: string
}

export interface BackupResult {
  success: boolean
  output: string
}

export interface DnsProviderInfo {
  name: string
  label: string
  docsUrl: string
  setup: string
  fields: { key: string; label: string; secret: boolean; placeholder: string; optional: boolean }[]
}
