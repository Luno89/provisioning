/**
 * VpsCatalogService — live VPS plan/price search across providers.
 *
 * Exists because provider pricing moves faster than any hardcoded list: Hetzner raised prices
 * three times in 2026 and nearly tripled its dedicated-vCPU line in June, which silently turned
 * the cluster wizard's baked-in plan list into bad advice. Querying each provider's own catalogue
 * API means the numbers are whatever the provider says today.
 *
 * Two providers publish their catalogue with no auth (Linode, Vultr). Hetzner and DigitalOcean
 * require the requesting user's own API token, which CredentialService already stores encrypted —
 * so the catalogue shows more the more providers a user has connected, and explains the gaps.
 */
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

/**
 * Provider catalogues change on the order of months, and every miss costs a round trip to a third
 * party. Six hours keeps the data honest without turning a page load into four API calls.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  offers: VpsOffer[];
  skippedNoPrice: number;
  fetchedAt: number;
}

export class VpsCatalogService {
  /** Keyed by `<provider>:<credential fingerprint>` — see cacheKey(). */
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: Database,
    private readonly masterKey: string,
    /** Injectable so tests can drive failing/malformed adapters; production uses the real list. */
    private readonly adapters: readonly VpsCatalogAdapter[] = ADAPTERS,
  ) {}

  /**
   * Public catalogues share one cache entry across all users. Credentialed ones are keyed by a
   * short hash of the token so two users with different Hetzner projects can't read each other's
   * cached result — projects can legitimately differ in which plans they're offered.
   */
  private cacheKey(provider: string, token?: string): string {
    if (!token) return `${provider}:public`;
    let h = 0;
    for (let i = 0; i < token.length; i++) h = (Math.imul(31, h) + token.charCodeAt(i)) | 0;
    return `${provider}:${h}`;
  }

  /** Resolves a provider token through the same chain everything else uses: user → env. */
  private async resolveToken(userId: string, provider: string): Promise<string | undefined> {
    const user = await this.db.getUserById(userId);
    const enc = (user?.credentials as any)?.[provider]?.token;
    let userCreds: any;
    if (enc) {
      try {
        userCreds = { [provider]: { token: decryptValue(enc, this.masterKey) } };
      } catch {
        // Corrupt blob or rotated master key — fall through to the env link in the chain.
      }
    }
    const env = resolveCloudCredentials(provider, userCreds).env;
    return env.HCLOUD_TOKEN ?? env.DIGITALOCEAN_TOKEN;
  }

  async search(userId: string, filters: VpsCatalogFilters = {}): Promise<VpsCatalogResult> {
    const sources: VpsCatalogSource[] = [];
    const all: VpsOffer[] = [];

    // Fetched in parallel: one slow or down provider shouldn't serialise the others.
    await Promise.all(
      this.adapters.map(async (adapter) => {
        // EVERYTHING for one provider stays inside this try. Reporting per-provider `sources` only
        // degrades gracefully if nothing here can throw out into Promise.all — a rejection there
        // fails the whole search and 500s the route, so one bad provider takes down four healthy
        // ones. Token resolution and the cache-hit spread both used to sit outside the try, which
        // is exactly how a stale worker process turned into an empty catalogue with no explanation.
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
          // Validated BEFORE it reaches the cache. The old order wrote the entry first and only
          // failed on the spread afterwards, so a single malformed result poisoned the cache for
          // the full 6h TTL and every later request died on the cache-hit path instead.
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
          // Serve stale rather than nothing — an expired cache entry is far more useful than an
          // empty table when a provider's API is briefly down. Re-checked with isArray because the
          // entry itself may be what failed above.
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

  /** Drops every cached catalogue so the next search re-fetches. Backs the UI's Refresh button. */
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
    // Explicit true/false, not truthiness — `false` legitimately means "exclude GPU plans", which
    // is the common case when shopping for an app server and Vultr's GPU line dominates any
    // vCPU- or bandwidth-sorted view.
    if (f.hasGpu === true && !offerHasGpu(o)) return false;
    if (f.hasGpu === false && offerHasGpu(o)) return false;
    if (f.minGpuVramGb !== undefined && !(o.gpuVramGb !== undefined && o.gpuVramGb >= f.minGpuVramGb)) return false;
    if (f.provider && o.provider !== f.provider) return false;
    if (f.provisionableOnly && !o.provisionable) return false;
    if (f.hourlyOnly && !o.hourlyBilling) return false;
    if (f.location) {
      const needle = f.location.toLowerCase();
      // An offer with no location list is global (Linode prices plans globally), so it matches
      // any location filter rather than being wrongly excluded.
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
      // Group by provider first — an alphabetical mix of five providers' plan ids is noise.
      return mul * (a.provider.localeCompare(b.provider) || a.planId.localeCompare(b.planId));
    }

    const value = (o: typeof a): number | undefined => {
      switch (sort) {
        case 'price': return o.priceMonthly;
        // Not derived from the monthly figure: providers set it independently, and for a platform
        // that creates and destroys clusters on demand it is the number that actually bills.
        case 'priceHourly': return o.priceHourly;
        case 'ram': return o.ramGb;
        case 'vcpu': return o.vcpu;
        case 'disk': return o.diskGb > 0 ? o.diskGb : undefined;      // 0 means unknown, not 0GB
        case 'bandwidth': return o.bandwidthTb;                        // absent on some providers
        // VRAM where known, else the card count — so GPU plans still order sensibly on providers
        // that publish no VRAM at all (Linode). Non-GPU plans stay undefined and sink.
        case 'gpu': return o.gpuVramGb ?? o.gpuCount;
        case 'pricePerGbVram': return o.pricePerGbVram;
        case 'pricePerGbRam':
        default: return o.pricePerGbRam;
      }
    };

    const av = value(a);
    const bv = value(b);
    // Unknowns sink to the bottom in BOTH directions. Otherwise "sort by bandwidth ascending"
    // fills the top of the table with rows that just render "—", which is never what was wanted.
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    // Stable tiebreak so equal values don't reshuffle between renders.
    return mul * (av - bv) || a.id.localeCompare(b.id);
  });

  return f.limit ? out.slice(0, f.limit) : out;
}
