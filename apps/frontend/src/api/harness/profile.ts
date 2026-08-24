import { api } from '../client'
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

export const getConfig = (): Promise<HarnessConfig> =>
  api.get<HarnessConfig>('/harness/config').then((r) => r.data)
