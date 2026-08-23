import { api } from './client'
import type {
  ProviderStatus, GoogleDriveStatus, ValidationResult, BackupResult,
} from '../types/credentials'

/**
 * Every call to `/api/credentials` and `/api/backup`, in one place.
 *
 * ── THE BOUNDARY ──
 * `CloudAccounts.tsx` made nine raw `fetch` calls with hand-written URLs, each repeating
 * `credentials: 'include'`, each unpacking `res.ok`/`res.json()` itself, and each keeping its own
 * `useState` for loading and error. Nine copies of the same four lines around four lines that
 * mattered.
 *
 * Components import hooks; hooks call these; only `client.ts` knows the base URL. So a path change
 * is one edit, and "who calls this endpoint" is a find-references rather than a grep for a string
 * fragment.
 *
 * ── QUERY KEYS ARE PART OF THE CONTRACT ──
 * They live next to the calls that invalidate them. Keeping them here rather than inline at each
 * `useQuery` is what makes an invalidation after a mutation correct by construction instead of by
 * matching an array literal by eye — the classic react-query bug where a save succeeds and the list
 * silently keeps showing the old value.
 */

export const credentialKeys = {
  all: ['credentials'] as const,
  list: () => [...credentialKeys.all, 'list'] as const,
  one: (provider: string) => [...credentialKeys.all, provider] as const,
}

/** Which providers this user has configured, with masked summaries. */
export const listProviders = (): Promise<ProviderStatus[]> =>
  api.get<{ providers: ProviderStatus[] }>('/credentials').then((r) => r.data.providers)

/** The stored (masked) credentials for one provider. `null` when nothing is stored. */
export const getCredentials = (provider: string): Promise<Record<string, string> | null> =>
  api.get<{ credentials: Record<string, string> | null }>(`/credentials/${provider}`)
    .then((r) => r.data.credentials)

export const saveCredentials = (provider: string, values: Record<string, string>): Promise<void> =>
  api.put(`/credentials/${provider}`, values).then(() => undefined)

export const deleteCredentials = (provider: string): Promise<void> =>
  api.delete(`/credentials/${provider}`).then(() => undefined)

/**
 * Checks a credential against the provider's real API.
 *
 * For `googledrive` the backend deliberately ignores the body and tests the STORED token — its
 * refresh token arrives from the OAuth callback and is never typed into a form, so there would be
 * nothing here to send.
 */
export const validateCredentials = (
  provider: string,
  values: Record<string, string> = {},
): Promise<ValidationResult> =>
  api.post<ValidationResult>(`/credentials/validate/${provider}`, values).then((r) => r.data)

/** Google Drive's connection state. Empty object rather than null when not connected. */
export const getDriveStatus = (): Promise<GoogleDriveStatus> =>
  api.get<{ credentials: GoogleDriveStatus | null }>('/credentials/googledrive')
    .then((r) => r.data.credentials ?? {})

/**
 * Starts the OAuth dance. A full navigation, not a fetch — Google will not answer XHR, and the
 * user has to see the consent screen.
 */
export const driveConnectUrl = (): string => `${api.defaults.baseURL}/credentials/googledrive/connect`

/** Runs a backup now. `success: false` means the script failed; the request itself worked. */
export const runBackup = (): Promise<BackupResult> =>
  api.post<BackupResult>('/backup/run').then((r) => r.data)
