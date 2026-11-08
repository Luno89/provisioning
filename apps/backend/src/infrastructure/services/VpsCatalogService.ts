import { NATURAL_SORT_DIR, offerHasGpu } from '../lib/vps-catalog/types.js';
import type {
  VpsCatalogAdapter,
  VpsCatalogFilters,
  VpsCatalogResult,
  VpsCatalogSource,
  VpsMarket,
  VpsOffer,
  VpsSortKey,
} from '../lib/vps-catalog/types.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  offers: VpsOffer[];
  skippedNoPrice: number;
  market?: VpsMarket;
  fetchedAt: number;
}

export class VpsCatalogService {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly adapters: readonly VpsCatalogAdapter[]) {}

  async search(filters: VpsCatalogFilters = {}): Promise<VpsCatalogResult> {
    const sources: VpsCatalogSource[] = [];
    const all: VpsOffer[] = [];

    await Promise.all(
      this.adapters.map(async (adapter) => {
        let hit: CacheEntry | undefined;
        try {
          hit = this.cache.get(adapter.provider);
          if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
            all.push(...hit.offers);
            sources.push({
              provider: adapter.provider,
              status: 'ok',
              offerCount: hit.offers.length,
              cached: true,
              ...(hit.skippedNoPrice ? { skippedNoPrice: hit.skippedNoPrice } : {}),
              ...(hit.market ? { market: hit.market } : {}),
            });
            return;
          }

          const result = await adapter.fetch();
          if (!result || !Array.isArray(result.offers)) {
            throw new Error(`${adapter.provider} adapter returned no offers array`);
          }
          const { offers, skippedNoPrice, market } = result;
          this.cache.set(adapter.provider, {
            offers,
            skippedNoPrice: skippedNoPrice ?? 0,
            ...(market ? { market } : {}),
            fetchedAt: Date.now(),
          });
          all.push(...offers);
          sources.push({
            provider: adapter.provider,
            status: 'ok',
            offerCount: offers.length,
            cached: false,
            ...(skippedNoPrice ? { skippedNoPrice } : {}),
            ...(market ? { market } : {}),
          });
        } catch (caught) {
          const err = caught as Error;
          if (hit && Array.isArray(hit.offers)) {
            all.push(...hit.offers);
            sources.push({
              provider: adapter.provider,
              status: 'ok',
              offerCount: hit.offers.length,
              cached: true,
              ...(hit.skippedNoPrice ? { skippedNoPrice: hit.skippedNoPrice } : {}),
              ...(hit.market ? { market: hit.market } : {}),
              message: `Served from an expired cache — refresh failed: ${err.message}`,
            });
            return;
          }
          sources.push({
            provider: adapter.provider,
            status: 'error',
            offerCount: 0,
            cached: false,
            message: err.message,
          });
        }
      }),
    );

    return {
      offers: applyFilters(all, filters),
      sources: sources.sort((a, b) => a.provider.localeCompare(b.provider)),
      fetchedAt: new Date().toISOString(),
    };
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export function applyFilters(offers: VpsOffer[], f: VpsCatalogFilters): VpsOffer[] {
  let out = offers.filter((o) => {
    if (f.minRamGb !== undefined && o.ramGb < f.minRamGb) return false;
    if (f.maxRamGb !== undefined && o.ramGb > f.maxRamGb) return false;
    if (f.minVcpu !== undefined && o.vcpu < f.minVcpu) return false;
    if (f.minDiskGb !== undefined && o.diskGb < f.minDiskGb) return false;
    if (f.maxPriceMonthly !== undefined && o.priceMonthly > f.maxPriceMonthly) return false;
    if (f.arch && o.arch !== f.arch) return false;
    if (f.cpuType && o.cpuType !== f.cpuType) return false;
    if (f.hasGpu === true && !offerHasGpu(o)) return false;
    if (f.hasGpu === false && offerHasGpu(o)) return false;
    if (f.minGpuVramGb !== undefined && !(o.gpuVramGb !== undefined && o.gpuVramGb >= f.minGpuVramGb)) return false;
    if (f.provider && o.provider !== f.provider) return false;
    if (f.hourlyOnly && !o.hourlyBilling) return false;
    if (f.location) {
      const needle = f.location.toLowerCase();
      if (o.locations.length > 0 && !o.locations.some((l) => l.toLowerCase().includes(needle))) {
        return false;
      }
    }
    return true;
  });

  const sort: VpsSortKey = f.sort ?? 'pricePerGbRam';
  const dir = f.sortDir ?? NATURAL_SORT_DIR[sort];
  const mul = dir === 'asc' ? 1 : -1;

  out = out.sort((a, b) => {
    if (sort === 'name') {
      return mul * (a.provider.localeCompare(b.provider) || a.planId.localeCompare(b.planId));
    }

    const value = (o: typeof a): number | undefined => {
      switch (sort) {
        case 'price': return o.priceMonthly;
        case 'priceHourly': return o.priceHourly;
        case 'ram': return o.ramGb;
        case 'vcpu': return o.vcpu;
        case 'disk': return o.diskGb > 0 ? o.diskGb : undefined;
        case 'bandwidth': return o.bandwidthTb;
        case 'gpu': return o.gpuVramGb ?? o.gpuCount;
        case 'pricePerGbVram': return o.pricePerGbVram;
        case 'pricePerGbRam':
        default: return o.pricePerGbRam;
      }
    };

    const av = value(a);
    const bv = value(b);
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    return mul * (av - bv) || a.id.localeCompare(b.id);
  });

  return f.limit ? out.slice(0, f.limit) : out;
}
