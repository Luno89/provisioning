/**
 * Per-provider catalogue adapters.
 *
 * Field mappings below were checked against the live APIs, not inferred from docs — including the
 * awkward parts (Linode's null-priced plans, Vultr's 0-RAM bare-metal entries, Hetzner's per-
 * location pricing and net/gross split).
 */
import { withDerived, type VpsArch, type VpsCatalogAdapter, type VpsCpuType, type VpsOffer } from './types.js';

const TIMEOUT_MS = 15_000;

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Linode / Akamai ────────────────────────────────────────────────────────
// Public, no auth. Sizes in MB. `class` distinguishes shared from dedicated.
export const linodeAdapter: VpsCatalogAdapter = {
  provider: 'linode',
  requiresCredentials: false,
  // No ProvisionClusterActivity branch yet — priced for comparison only.
  provisionable: false,
  async fetch() {
    const data = await getJson('https://api.linode.com/v4/linode/types');
    const offers: VpsOffer[] = [];
    for (const p of data?.data ?? []) {
      // Some plans (GPU/premium tiers) return a null monthly price. Skipping beats rendering a
      // "$0/mo" row that looks like the cheapest option on the page.
      const monthly = p?.price?.monthly;
      if (typeof monthly !== 'number' || monthly <= 0) continue;

      const cls = String(p.class ?? '');
      const cpuType: VpsCpuType =
        cls === 'dedicated' || cls === 'premium' || cls === 'highmem' ? 'dedicated'
        : cls === 'nanode' || cls === 'standard' ? 'shared'
        : 'unknown';

      offers.push(withDerived({
        provider: 'linode',
        planId: String(p.id),
        label: String(p.label ?? p.id),
        vcpu: Number(p.vcpus ?? 0),
        cpuType,
        arch: 'x86', // Linode's compute line is x86 throughout.
        ramGb: Number(p.memory ?? 0) / 1024,
        diskGb: Number(p.disk ?? 0) / 1024,
        ...(p.transfer ? { bandwidthTb: Number(p.transfer) / 1000 } : {}),
        priceMonthly: monthly,
        ...(typeof p?.price?.hourly === 'number' ? { priceHourly: p.price.hourly } : {}),
        currency: 'USD',
        taxIncluded: false,
        hourlyBilling: true,
        locations: [], // Region-specific pricing exists in `region_prices`; base plan is global.
        provisionable: false,
      }));
    }
    return offers;
  },
};

// ── Vultr ──────────────────────────────────────────────────────────────────
// Public, no auth. Richest catalogue of the four: bandwidth, CPU vendor and disk type included.
export const vultrAdapter: VpsCatalogAdapter = {
  provider: 'vultr',
  requiresCredentials: false,
  provisionable: false,
  async fetch() {
    const data = await getJson('https://api.vultr.com/v2/plans?per_page=500');
    const offers: VpsOffer[] = [];
    for (const p of data?.plans ?? []) {
      const monthly = Number(p?.monthly_cost ?? 0);
      if (!monthly) continue;

      // Checked live: `vcpu_type` is the literal string "thread" on every plan and carries no
      // shared/dedicated information at all. The plan-family prefix in `type` is the real signal.
      const family = String(p.type ?? '');
      const cpuType: VpsCpuType =
        family === 'vdm' || family === 'voc' || family === 'vcg' ? 'dedicated'
        : family === 'vc2' || family === 'vhf' || family === 'vhp' ? 'shared'
        : 'unknown';

      // Also checked live: cpu_vendor is only ever ''/AMD/Intel today, so this never yields 'arm'
      // for Vultr. Kept because the field is the right place to detect it if they add Ampere —
      // and Hetzner's CAX line, read from its own `architecture` field, does return arm.
      const vendor = String(p.cpu_vendor ?? '').toLowerCase();
      const arch: VpsArch = vendor.includes('ampere') || vendor.includes('arm') ? 'arm' : 'x86';

      // Multi-disk plans report per-disk size. And some families (disk_type "VX") report a
      // placeholder `disk: 1` that is plainly not the real capacity — a 32GB-RAM plan does not
      // ship a 1GB volume. Report 0 ("unknown") rather than a number that reads as real and would
      // wrongly satisfy or fail a minDiskGb filter.
      const diskCount = Number(p.disk_count ?? 1) || 1;
      const rawDisk = Number(p.disk ?? 0) * diskCount;
      const diskGb = rawDisk <= 1 ? 0 : rawDisk;

      offers.push(withDerived({
        provider: 'vultr',
        planId: String(p.id),
        label: String(p.id),
        vcpu: Number(p.vcpu_count ?? 0),
        cpuType,
        ...(p.cpu_vendor ? { cpuVendor: String(p.cpu_vendor) } : {}),
        arch,
        ramGb: Number(p.ram ?? 0) / 1024,
        diskGb,
        ...(p.disk_type ? { diskType: String(p.disk_type) } : {}),
        // Vultr reports bandwidth in GB.
        ...(p.bandwidth ? { bandwidthTb: Number(p.bandwidth) / 1000 } : {}),
        priceMonthly: monthly,
        ...(typeof p.hourly_cost === 'number' ? { priceHourly: p.hourly_cost } : {}),
        currency: 'USD',
        taxIncluded: false,
        hourlyBilling: true,
        locations: Array.isArray(p.locations) ? p.locations.map(String) : [],
        provisionable: false,
      }));
    }
    return offers;
  },
};

// ── Hetzner Cloud ──────────────────────────────────────────────────────────
// Needs the user's API token. Prices are PER LOCATION and split net/gross.
export const hetznerAdapter: VpsCatalogAdapter = {
  provider: 'hetzner',
  requiresCredentials: true,
  // The only provider with a real provisioning path today (constructs/hetzner-vm.ts).
  provisionable: true,
  async fetch(token?: string) {
    if (!token) return [];
    const data = await getJson('https://api.hetzner.cloud/v1/server_types?per_page=100', {
      Authorization: `Bearer ${token}`,
    });
    const offers: VpsOffer[] = [];
    for (const st of data?.server_types ?? []) {
      if (st?.deprecated) continue; // Not orderable; showing it invites picking a dead plan.

      const prices: any[] = Array.isArray(st.prices) ? st.prices : [];
      // Net, not gross: US providers quote pre-tax, and mixing the two overstates Hetzner by
      // ~19% against them. Cheapest location wins, since price varies by datacenter.
      const monthlyNet = prices
        .map((p) => Number(p?.price_monthly?.net ?? NaN))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (monthlyNet.length === 0) continue;
      const monthly = Math.min(...monthlyNet);
      const hourlyNet = prices
        .map((p) => Number(p?.price_hourly?.net ?? NaN))
        .filter((n) => Number.isFinite(n) && n > 0);

      const arch: VpsArch = String(st.architecture ?? 'x86') === 'arm' ? 'arm' : 'x86';

      offers.push(withDerived({
        provider: 'hetzner',
        planId: String(st.name),
        label: `${String(st.name).toUpperCase()} — ${st.description ?? ''}`.trim(),
        vcpu: Number(st.cores ?? 0),
        cpuType: String(st.cpu_type ?? '') === 'dedicated' ? 'dedicated' : 'shared',
        arch,
        ramGb: Number(st.memory ?? 0),
        diskGb: Number(st.disk ?? 0),
        priceMonthly: monthly,
        ...(hourlyNet.length ? { priceHourly: Math.min(...hourlyNet) } : {}),
        currency: 'EUR',
        taxIncluded: false,
        hourlyBilling: true,
        locations: prices.map((p) => String(p?.location ?? '')).filter(Boolean),
        provisionable: true,
      }));
    }
    return offers;
  },
};

// ── DigitalOcean ───────────────────────────────────────────────────────────
export const digitalOceanAdapter: VpsCatalogAdapter = {
  provider: 'do',
  requiresCredentials: true,
  provisionable: false,
  async fetch(token?: string) {
    if (!token) return [];
    const data = await getJson('https://api.digitalocean.com/v2/sizes?per_page=200', {
      Authorization: `Bearer ${token}`,
    });
    const offers: VpsOffer[] = [];
    for (const s of data?.sizes ?? []) {
      if (s?.available === false) continue;
      const monthly = Number(s?.price_monthly ?? 0);
      if (!monthly) continue;

      const slug = String(s.slug ?? '');
      offers.push(withDerived({
        provider: 'do',
        planId: slug,
        label: String(s.description ?? slug),
        vcpu: Number(s.vcpus ?? 0),
        // DO encodes the tier in the slug: `s-` shared, `c-`/`g-`/`m-` dedicated families.
        cpuType: slug.startsWith('s-') ? 'shared' : 'dedicated',
        arch: 'x86',
        ramGb: Number(s.memory ?? 0) / 1024,
        diskGb: Number(s.disk ?? 0),
        ...(s.transfer ? { bandwidthTb: Number(s.transfer) } : {}),
        priceMonthly: monthly,
        ...(typeof s.price_hourly === 'number' ? { priceHourly: s.price_hourly } : {}),
        currency: 'USD',
        taxIncluded: false,
        hourlyBilling: true,
        locations: Array.isArray(s.regions) ? s.regions.map(String) : [],
        provisionable: false,
      }));
    }
    return offers;
  },
};

export const ADAPTERS: readonly VpsCatalogAdapter[] = [
  hetznerAdapter,
  linodeAdapter,
  vultrAdapter,
  digitalOceanAdapter,
];
