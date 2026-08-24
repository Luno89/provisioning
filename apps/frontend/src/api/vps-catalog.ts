import { api } from './client'

/**
 * Rentable VPS offers, scraped and cached server-side.
 *
 * The shapes below were private to `VpsCatalog.tsx`. They describe a WIRE response, so they belong
 * beside the call that produces it — a second screen wanting the same list would otherwise have
 * copied them.
 */

export interface VpsOffer {
  id: string; provider: string; planId: string; label: string;
  vcpu: number; cpuType: string; cpuVendor?: string; arch: string;
  ramGb: number; diskGb: number; diskType?: string; bandwidthTb?: number;
  gpuCount?: number; gpuVramGb?: number; gpuModel?: string;
  priceMonthly: number; priceHourly?: number; currency: string; taxIncluded: boolean;
  hourlyBilling: boolean; locations: string[]; provisionable: boolean;
  pricePerGbRam: number; pricePerGbVram?: number;
}
export interface VpsSource {
  provider: string; status: 'ok' | 'no-credentials' | 'error';
  offerCount: number; message?: string; requiresCredentials: boolean; cached: boolean;
  skippedNoPrice?: number;
}
export interface CatalogResult { offers: VpsOffer[]; sources: VpsSource[]; fetchedAt: string }


export const vpsKeys = {
  /** Keyed on the built query string, which IS the identity of a filtered result. */
  catalog: (query: string) => ['vps-catalog', query] as const,
}

/**
 * Takes the query string the caller already built.
 *
 * The filter panel owns a dozen pieces of state and assembles them with URLSearchParams, dropping
 * empties — re-deriving that here from a params object would be a second, subtly different answer
 * to which filters are "set".
 */
export const getVpsCatalog = (query: string): Promise<CatalogResult> =>
  api.get<CatalogResult>(`/vps-catalog?${query}`).then((r) => r.data)

/** Forces a re-scrape. Slow and rate-limited upstream, so it is a button and not a poll. */
export const refreshVpsCatalog = () =>
  api.post('/vps-catalog/refresh', {}).then((r) => r.data)
