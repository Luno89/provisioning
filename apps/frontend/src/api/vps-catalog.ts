import { api } from './client'

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
  catalog: (query: string) => ['vps-catalog', query] as const,
}

export const getVpsCatalog = (query: string): Promise<CatalogResult> =>
  api.get<CatalogResult>(`/vps-catalog?${query}`).then((r) => r.data)

export const refreshVpsCatalog = () =>
  api.post('/vps-catalog/refresh', {}).then((r) => r.data)
