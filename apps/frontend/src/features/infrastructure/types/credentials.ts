
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
