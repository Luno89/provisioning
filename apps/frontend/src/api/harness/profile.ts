import { api, API_BASE } from '../client'
import type { HarnessProfile, HarnessConfig } from '@koala/harness-types'

/** The adopted knob profile, and what the harness would send with it. */

export const profileKeys = {
  profile: () => ['harness-profile'] as const,
  preview: (params?: unknown) => ['harness-profile-preview', params] as const,
  config: () => ['harness-config'] as const,
}

export const getProfile = (): Promise<HarnessProfile> =>
  api.get<HarnessProfile>('/harness/profile').then((r) => r.data)

export const saveProfile = (body: unknown): Promise<HarnessProfile> =>
  api.put<HarnessProfile>('/harness/profile', body).then((r) => r.data)

/** Drops every adopted override, returning the harness to its declared defaults. */
export const resetProfile = () => api.delete('/harness/profile').then((r) => r.data)

/**
 * The effective knobs a run would use, resolved server-side.
 *
 * Resolved there rather than here on purpose: the chain is adopted profile → persona → request,
 * and a second implementation of it in the UI is a second answer to "what will actually run".
 */
export const previewProfile = (params?: Record<string, unknown>) =>
  api.get('/harness/profile/preview', { params }).then((r) => r.data)

/**
 * Adopts one variant's overrides as the standing profile.
 *
 * Takes the experiment AND the variant label, because a label is only unique within an experiment.
 */
export const promoteVariant = (experimentId: string, label: string) =>
  api.post('/harness/profile/promote', { experimentId, label }).then((r) => r.data)

/** What adopting that variant would change, previewed before committing to it. */
export const getPromotionStanding = (params: { experimentId: string; label: string }) =>
  api.get('/harness/profile/promote', { params }).then((r) => r.data)

/**
 * Where the browser downloads the whole harness document from.
 *
 * A real URL rather than a fetch: this is an `<a href download>`, so the browser does the transfer
 * and names the file. It is the second legitimate absolute-URL case after `clusterDashboardUrl` —
 * and building it inline is what left `${apiBase}` embedded in a template string here.
 */
export const harnessExportUrl = (): string => `${API_BASE}/harness/export`

export const getConfig = (): Promise<HarnessConfig> =>
  api.get<HarnessConfig>('/harness/config').then((r) => r.data)

/**
 * The result of importing a harness document.
 *
 * Three lists, not a boolean: an import is routinely PARTIAL — some experiments created, some
 * refused for being malformed, some skipped because they already exist. Collapsing that into
 * success/failure would throw away the only information the user can act on.
 */
export interface ImportResult {
  created?: string[]
  failed?: string[]
  rejected?: string[]
}

export const importHarnessConfig = (doc: unknown): Promise<ImportResult> =>
  api.post<ImportResult>('/harness/import', doc).then((r) => r.data)
