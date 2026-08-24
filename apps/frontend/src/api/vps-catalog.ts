import { api } from './client'

/** Rentable VPS offers, scraped and cached server-side. */

export const vpsKeys = {
  catalog: (params?: Record<string, unknown>) => ['vps-catalog', params] as const,
}

export const getVpsCatalog = (params?: Record<string, unknown>) =>
  api.get('/vps-catalog', { params }).then((r) => r.data)

/** Forces a re-scrape. Slow and rate-limited upstream, so it is a button and not a poll. */
export const refreshVpsCatalog = () =>
  api.post('/vps-catalog/refresh', {}).then((r) => r.data)
