/**
 * ── DUPLICATED, KNOWINGLY ──
 *
 * The authority is `ProviderStatus` in `apps/backend/src/services/CredentialService.ts`. If this
 * ever disagrees with it, the backend is right.
 *
 * It cannot be imported. `@koala/harness-types` is types-only BY DESIGN — it has no build step and
 * every import of it is `import type`, which both `tsx` and Vite erase before anything runs. Adding
 * a single runtime value would force a build and bundling story onto a package that deliberately
 * has neither. `CloudProvider` is a runtime list (`CLOUD_PROVIDERS`), so moving this there would
 * drag that constraint with it.
 *
 * So the rule lives in two places and they can drift. This block is the mitigation: the form
 * `Lab/shared.ts` established for exactly this situation, so a reader knows which side to trust
 * without having to guess.
 */

export interface ProviderStatus {
  /** A `CloudProvider` on the backend; a plain string here, since the frontend never switches on it. */
  provider: string
  label: string
  configured: boolean
  /**
   * Where the credential came from. `env` means the platform's own process environment rather than
   * anything this user stored, which is why those cards are read-only.
   */
  source?: 'user' | 'env'
  /** Masked values for display — e.g. `{ HF_TOKEN: 'hf_h****wcDG' }`. Never the plaintext. */
  summary?: Record<string, string>
}

/** What `GET /api/credentials/googledrive` returns once Drive is connected. */
export interface GoogleDriveStatus {
  email?: string
  /** Masked, e.g. `"****"` — present only when a backup password has been set. */
  backupPassword?: string
}

/** The result of `POST /api/credentials/validate/:provider`. */
export interface ValidationResult {
  valid?: boolean
  message?: string
}

/** The result of `POST /api/backup/run`. `success: false` is a failed backup, not a failed request. */
export interface BackupResult {
  success: boolean
  output: string
}
