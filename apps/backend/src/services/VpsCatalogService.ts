import type { Database } from '../lib/db-interface.js';
import { decryptValue } from '../lib/crypto.js';
import { resolveCloudCredentials } from '../lib/credential-resolver.js';
import { ADAPTERS } from '../lib/vps-catalog/adapters.js';
import { NATURAL_SORT_DIR, offerHasGpu } from '../lib/vps-catalog/types.js';
import type {
  VpsCatalogAdapter,
  VpsCatalogFilters,
  VpsCatalogResult,
  VpsCatalogSource,
  VpsOffer,
  VpsSortKey,
} from '../lib/vps-catalog/types.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  offers: VpsOffer[];
  skippedNoPrice: number;
  fetchedAt: number;
}

export class VpsCatalogService {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: Database,
    private readonly masterKey: string,
    private readonly adapters: readonly VpsCatalogAdapter[] = ADAPTERS,
  ) {}

  private cacheKey(provider: string, token?: string): string {
    if (!token) return `${provider}:public`;
    let h = 0;
    for (let i = 0; i < token.length; i++) h = (Math.imul(31, h) + token.charCodeAt(i)) | 0;
    return `${provider}:${h}`;
  }

  private async resolveToken(userId: string, provider: string): Promise<string | undefined> {
    const user = await this.db.getUserById(userId);
    const enc = (user?.credentials as any)?.[provider]?.token;
    let userCreds: any;
    if (enc) {
      try {
        userCreds = { [provider]: { token: decryptValue(enc, this.masterKey) } };
      } catch { /* ignored */ }
    }
    const env = resolveCloudCredentials(provider, userCreds).env;
    return env.HCLOUD_TOKEN ?? env.DIGITALOCEAN_TOKEN;
  }

  async search(userId: string, filters: VpsCatalogFilters = {}): Promise<VpsCatalogResult> {
    const sources: VpsCatalogSource[] = [];
    const all: VpsOffer[] = [];

    await Promise.all(
      this.adapters.map(async (adapter) => {
        let hit: CacheEntry | undefined;
        try {
          const token = adapter.requiresCredentials
            ? await this.resolveToken(userId, adapter.provider)
            : undefined;

          if (adapter.requiresCredentials && !token) {
            sources.push({
              provider: adapter.provider,
              status: 'no-credentials',
              offerCount: 0,
              requiresCredentials: true,
              cached: false,
              message: `Add a ${adapter.provider} API token under Cloud Accounts to include its plans.`,
            });
            return;
          }

          const key = this.cacheKey(adapter.provider, token);
          hit = this.cache.get(key);
          if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
            all.push(...hit.offers);
            sources.push({
              provider: adapter.provider,
              status: 'ok',
              offerCount: hit.offers.length,
              requiresCredentials: adapter.requiresCredentials,
              cached: true,
              ...(hit.skippedNoPrice ? { skippedNoPrice: hit.skippedNoPrice } : {}),
            });
            return;
          }

          const result = await adapter.fetch(token);
          if (!result || !Array.isArray(result.offers)) {
            throw new Error(`${adapter.provider} adapter returned no offers array`);
          }
          const { offers, skippedNoPrice } = result;
          this.cache.set(key, { offers, skippedNoPrice: skippedNoPrice ?? 0, fetchedAt: Date.now() });
          all.push(...offers);
          sources.push({
            provider: adapter.provider,
            status: 'ok',
            offerCount: offers.length,
            requiresCredentials: adapter.requiresCredentials,
            cached: false,
            ...(skippedNoPrice ? { skippedNoPrice } : {}),
          });
        } catch (err: any) {
          if (hit && Array.isArray(hit.offers)) {
            all.push(...hit.offers);
            sources.push({
              provider: adapter.provider,
              status: 'ok',
              offerCount: hit.offers.length,
              requiresCredentials: adapter.requiresCredentials,
              cached: true,
              ...(hit.skippedNoPrice ? { skippedNoPrice: hit.skippedNoPrice } : {}),
              message: `Served from an expired cache — refresh failed: ${err.message}`,
            });
            return;
          }
          sources.push({
            provider: adapter.provider,
            status: 'error',
            offerCount: 0,
            requiresCredentials: adapter.requiresCredentials,
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
    if (f.provisionableOnly && !o.provisionable) return false;
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
