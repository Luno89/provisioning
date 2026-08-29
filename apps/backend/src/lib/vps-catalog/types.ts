
export type VpsArch = 'x86' | 'arm' | 'unknown';
export type VpsCpuType = 'shared' | 'dedicated' | 'unknown';

export interface VpsOffer {
  readonly id: string;
  readonly provider: string;
  readonly planId: string;
  readonly label: string;

  readonly vcpu: number;
  readonly cpuType: VpsCpuType;
  readonly cpuVendor?: string;
  readonly arch: VpsArch;

  readonly ramGb: number;
  readonly diskGb: number;
  readonly diskType?: string;

  readonly gpuCount?: number;
  readonly gpuVramGb?: number;
  readonly gpuModel?: string;

  readonly bandwidthTb?: number;

  readonly priceMonthly: number;
  readonly priceHourly?: number;
  readonly currency: string;
  readonly taxIncluded: boolean;

  readonly hourlyBilling: boolean;

  readonly locations: readonly string[];

  readonly provisionable: boolean;

  readonly pricePerGbRam: number;
  readonly pricePerGbVram?: number;
}

export function offerHasGpu(o: Pick<VpsOffer, 'gpuCount' | 'gpuVramGb' | 'gpuModel'>): boolean {
  return Boolean((o.gpuCount && o.gpuCount > 0) || o.gpuVramGb || o.gpuModel);
}

export type VpsSortKey =
  | 'price' | 'priceHourly' | 'pricePerGbRam' | 'ram' | 'vcpu' | 'disk' | 'bandwidth' | 'name'
  | 'gpu' | 'pricePerGbVram';

export const NATURAL_SORT_DIR: Record<VpsSortKey, 'asc' | 'desc'> = {
  price: 'asc',
  priceHourly: 'asc',
  pricePerGbRam: 'asc',
  ram: 'desc',
  vcpu: 'desc',
  disk: 'desc',
  bandwidth: 'desc',
  name: 'asc',
  gpu: 'desc',
  pricePerGbVram: 'asc',
};

export interface VpsCatalogFilters {
  minRamGb?: number;
  maxRamGb?: number;
  minVcpu?: number;
  minDiskGb?: number;
  maxPriceMonthly?: number;
  location?: string;
  arch?: VpsArch;
  cpuType?: VpsCpuType;
  hasGpu?: boolean;
  minGpuVramGb?: number;
  provider?: string;
  provisionableOnly?: boolean;
  hourlyOnly?: boolean;
  sort?: VpsSortKey;
  sortDir?: 'asc' | 'desc';
  limit?: number;
}

export interface VpsCatalogResult {
  offers: VpsOffer[];
  sources: VpsCatalogSource[];
  fetchedAt: string;
}

export interface VpsCatalogSource {
  provider: string;
  status: 'ok' | 'no-credentials' | 'error';
  offerCount: number;
  message?: string;
  requiresCredentials: boolean;
  cached: boolean;
  skippedNoPrice?: number;
}

export interface VpsCatalogAdapter {
  readonly provider: string;
  readonly requiresCredentials: boolean;
  readonly provisionable: boolean;
  fetch(token?: string): Promise<AdapterResult>;
}

export interface AdapterResult {
  offers: VpsOffer[];
  skippedNoPrice: number;
}

export function withDerived(
  offer: Omit<VpsOffer, 'id' | 'pricePerGbRam' | 'pricePerGbVram'> & { idSuffix?: string },
): VpsOffer {
  const { idSuffix, ...rest } = offer;
  return {
    ...rest,
    id: `${offer.provider}:${offer.planId}${idSuffix ? `@${idSuffix}` : ''}`,
    pricePerGbRam: offer.ramGb > 0 ? offer.priceMonthly / offer.ramGb : 0,
    ...(offer.gpuVramGb && offer.gpuVramGb > 0
      ? { pricePerGbVram: offer.priceMonthly / offer.gpuVramGb }
      : {}),
  };
}
