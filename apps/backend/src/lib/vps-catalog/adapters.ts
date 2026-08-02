/**
 * Per-provider catalogue adapters.
 *
 * Field mappings below were checked against the live APIs, not inferred from docs — including the
 * awkward parts (Linode's null-priced plans, Vultr's 0-RAM bare-metal entries, Hetzner's per-
 * location pricing and net/gross split).
 */
import { withDerived, type AdapterResult, type VpsArch, type VpsCatalogAdapter, type VpsCpuType, type VpsOffer } from './types.js';

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
    let skippedNoPrice = 0;
    for (const p of data?.data ?? []) {
      // Some plans (GPU/premium tiers) return a null monthly price. Skipping beats rendering a
      // "$0/mo" row that looks like the cheapest option on the page.
      const monthly = p?.price?.monthly;
      if (typeof monthly !== 'number' || monthly <= 0) { skippedNoPrice++; continue; }

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
        // Linode reports a GPU count but no VRAM; the card model is only in the human label
        // (e.g. "Dedicated 32GB + RTX6000 GPU x1"), so it's extracted from there.
        ...(Number(p.gpus ?? 0) > 0 ? { gpuCount: Number(p.gpus) } : {}),
        ...(Number(p.gpus ?? 0) > 0 && /\+\s*([A-Za-z0-9]+)\s*GPU/i.exec(String(p.label ?? ''))
          ? { gpuModel: /\+\s*([A-Za-z0-9]+)\s*GPU/i.exec(String(p.label))![1]! }
          : {}),
        priceMonthly: monthly,
        ...(typeof p?.price?.hourly === 'number' ? { priceHourly: p.price.hourly } : {}),
        currency: 'USD',
        taxIncluded: false,
        hourlyBilling: true,
        locations: [], // Region-specific pricing exists in `region_prices`; base plan is global.
        provisionable: false,
      }));
    }
    return { offers, skippedNoPrice };
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
    let skippedNoPrice = 0;
    for (const p of data?.plans ?? []) {
      const monthly = Number(p?.monthly_cost ?? 0);
      if (!monthly) { skippedNoPrice++; continue; }

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

      // gpu_brand is present on EVERY plan and reads the literal string "none" on non-GPU ones,
      // so a truthiness check would classify all 151 plans as GPU machines.
      const gpuBrand = String(p.gpu_brand ?? '').trim();
      const hasGpu = gpuBrand !== '' && gpuBrand.toLowerCase() !== 'none';
      // Vultr publishes no structured VRAM field — it exists only in the plan id, e.g.
      // `vcg-a40-96c-480g-192vram`. Parsed rather than dropped because VRAM is the whole point of
      // a GPU plan, but left undefined when the id doesn't carry it rather than guessed at.
      const vramMatch = /-(\d+)vram(?:-|$)/.exec(String(p.id ?? ''));
      const gpuVramGb = hasGpu && vramMatch?.[1] ? Number(vramMatch[1]) : undefined;

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
        // Deliberately NO gpuCount: Vultr publishes neither a count nor per-card VRAM, and the id
        // encodes only the total. An earlier version reported 1 here as a "has a GPU" marker,
        // which is a fabricated number — a vcg-b200 with 1536GB of VRAM is plainly not one card,
        // and any price-per-card derived from it would be wrong by an order of magnitude.
        // gpuModel/gpuVramGb are enough to identify it as a GPU plan.
        ...(hasGpu ? { gpuModel: gpuBrand } : {}),
        ...(gpuVramGb !== undefined ? { gpuVramGb } : {}),
        priceMonthly: monthly,
        ...(typeof p.hourly_cost === 'number' ? { priceHourly: p.hourly_cost } : {}),
        currency: 'USD',
        taxIncluded: false,
        hourlyBilling: true,
        locations: Array.isArray(p.locations) ? p.locations.map(String) : [],
        provisionable: false,
      }));
    }
    return { offers, skippedNoPrice };
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
    if (!token) return { offers: [], skippedNoPrice: 0 };
    const data = await getJson('https://api.hetzner.cloud/v1/server_types?per_page=100', {
      Authorization: `Bearer ${token}`,
    });
    const offers: VpsOffer[] = [];
    let skippedNoPrice = 0;
    for (const st of data?.server_types ?? []) {
      if (st?.deprecated) continue; // Not orderable; showing it invites picking a dead plan.

      const prices: any[] = Array.isArray(st.prices) ? st.prices : [];

      // Hetzner prices the SAME plan differently per location, and not by a little: a CPX 11 is
      // €5.99 in Falkenstein and €20.49 in Ashburn, and the US locations bundle 1TB of traffic
      // against the EU's 20TB. 17 of 25 plans have multiple tiers.
      //
      // Collapsing that to Math.min() while listing every location on one row asserted a €5.99
      // Ashburn price that does not exist — understating US pricing by up to 3.7x on exactly the
      // rows a "cheap US VPS" search surfaces. One offer per distinct price tier instead, so a
      // location filter can only ever match a row whose price is real for that location.
      //
      // Net, not gross: US providers quote pre-tax, and mixing the two overstates Hetzner ~19%.
      const tiers = new Map<string, { monthly: number; hourly?: number; traffic?: number; locations: string[] }>();
      for (const p of prices) {
        const monthly = Number(p?.price_monthly?.net ?? NaN);
        if (!Number.isFinite(monthly) || monthly <= 0) continue;
        const hourly = Number(p?.price_hourly?.net ?? NaN);
        const traffic = Number(p?.included_traffic ?? NaN);
        const location = String(p?.location ?? '');
        const key = `${monthly}|${hourly}|${traffic}`;
        const seen = tiers.get(key);
        if (seen) {
          if (location) seen.locations.push(location);
          continue;
        }
        tiers.set(key, {
          monthly,
          ...(Number.isFinite(hourly) && hourly > 0 ? { hourly } : {}),
          ...(Number.isFinite(traffic) && traffic > 0 ? { traffic } : {}),
          locations: location ? [location] : [],
        });
      }
      if (tiers.size === 0) { skippedNoPrice++; continue; }

      const arch: VpsArch = String(st.architecture ?? 'x86') === 'arm' ? 'arm' : 'x86';
      const multiTier = tiers.size > 1;

      for (const tier of tiers.values()) {
        const locations = [...tier.locations].sort();
        offers.push(withDerived({
          provider: 'hetzner',
          planId: String(st.name),
          // Only suffixed when the plan really does split, so single-price plans keep a clean id.
          ...(multiTier && locations[0] ? { idSuffix: locations[0] } : {}),
          label: `${String(st.name).toUpperCase()} — ${st.description ?? ''}`.trim(),
          vcpu: Number(st.cores ?? 0),
          cpuType: String(st.cpu_type ?? '') === 'dedicated' ? 'dedicated' : 'shared',
          arch,
          ramGb: Number(st.memory ?? 0),
          diskGb: Number(st.disk ?? 0),
          priceMonthly: tier.monthly,
          ...(tier.hourly ? { priceHourly: tier.hourly } : {}),
          // included_traffic is bytes. Hetzner advertises the EU allowance as "20 TB" and the
          // value is 21990232555520 — that is 20 TiB, so binary units are what match both their
          // marketing and the figure a customer is comparing against.
          ...(tier.traffic ? { bandwidthTb: tier.traffic / 2 ** 40 } : {}),
          currency: 'EUR',
          taxIncluded: false,
          hourlyBilling: true,
          locations,
          provisionable: true,
        }));
      }
    }
    return { offers, skippedNoPrice };
  },
};

// ── DigitalOcean ───────────────────────────────────────────────────────────
export const digitalOceanAdapter: VpsCatalogAdapter = {
  provider: 'do',
  requiresCredentials: true,
  provisionable: false,
  async fetch(token?: string) {
    if (!token) return { offers: [], skippedNoPrice: 0 };
    const data = await getJson('https://api.digitalocean.com/v2/sizes?per_page=200', {
      Authorization: `Bearer ${token}`,
    });
    const offers: VpsOffer[] = [];
    let skippedNoPrice = 0;
    for (const s of data?.sizes ?? []) {
      if (s?.available === false) continue;
      const monthly = Number(s?.price_monthly ?? 0);
      if (!monthly) { skippedNoPrice++; continue; }

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
    return { offers, skippedNoPrice };
  },
};

// ── Scaleway ───────────────────────────────────────────────────────────────
// Public, no auth, and the only public catalogue here that reports architecture directly —
// roughly a third of its range is arm64, which matters for x86-only images.
//
// Products are per-zone and the ranges differ between them, so several zones are queried and
// merged by product name, accumulating the zones each product is available in.
const SCALEWAY_ZONES = ['fr-par-1', 'fr-par-2', 'nl-ams-1', 'pl-waw-1'] as const;

export const scalewayAdapter: VpsCatalogAdapter = {
  provider: 'scaleway',
  requiresCredentials: false,
  provisionable: false,
  async fetch() {
    const byPlan = new Map<string, { raw: any; zones: string[] }>();

    // allSettled, not all: one unreachable zone shouldn't drop the whole provider.
    const results = await Promise.allSettled(
      SCALEWAY_ZONES.map(async (z) => ({
        zone: z,
        data: await getJson(`https://api.scaleway.com/instance/v1/zones/${z}/products/servers`),
      })),
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const [name, raw] of Object.entries<any>(r.value.data?.servers ?? {})) {
        const existing = byPlan.get(name);
        if (existing) existing.zones.push(r.value.zone);
        else byPlan.set(name, { raw, zones: [r.value.zone] });
      }
    }

    const offers: VpsOffer[] = [];
    let skippedNoPrice = 0;
    for (const [name, { raw, zones }] of byPlan) {
      // end_of_service products can still be listed but can't be ordered.
      if (raw?.end_of_service) continue;
      const monthly = Number(raw?.monthly_price ?? 0);
      if (!monthly) { skippedNoPrice++; continue; }

      offers.push(withDerived({
        provider: 'scaleway',
        planId: name,
        label: name,
        vcpu: Number(raw.ncpus ?? 0),
        // Scaleway doesn't distinguish shared from dedicated in this payload.
        cpuType: 'unknown',
        arch: String(raw.arch ?? '') === 'arm64' ? 'arm' : 'x86',
        // RAM is bytes here, unlike Linode (MB) and Vultr (MB).
        ramGb: Math.round(Number(raw.ram ?? 0) / 1024 ** 3),
        // Local SSD is optional on most ranges (they default to network block storage), so a
        // 0 max_size means "no bundled local disk" rather than a real capacity.
        diskGb: Math.round(Number(raw?.per_volume_constraint?.l_ssd?.max_size ?? 0) / 1024 ** 3),
        // The only provider here reporting VRAM structurally — but gpu_memory is PER CARD, while
        // Vultr's plan-id figure is the total. Multiply by the card count so gpuVramGb means the
        // same thing everywhere; without this an L4-8-24G reports 24GB instead of 192GB and its
        // price-per-GB-VRAM comes out 8x too high. Confirmed against the live payload: the plan
        // naming (L4-<cards>-<per-card>G) matches gpu × gpu_memory exactly.
        ...(Number(raw.gpu ?? 0) > 0 ? { gpuCount: Number(raw.gpu) } : {}),
        ...(raw?.gpu_info?.gpu_memory
          ? {
              gpuVramGb: Math.round(
                (Number(raw.gpu_info.gpu_memory) / 1024 ** 3) * Math.max(1, Number(raw.gpu ?? 1)),
              ),
            }
          : {}),
        ...(raw?.gpu_info?.gpu_name
          ? { gpuModel: `${raw.gpu_info.gpu_manufacturer ?? ''} ${raw.gpu_info.gpu_name}`.trim() }
          : {}),
        priceMonthly: monthly,
        ...(typeof raw.hourly_price === 'number' ? { priceHourly: raw.hourly_price } : {}),
        currency: 'EUR',
        taxIncluded: false,
        hourlyBilling: true,
        locations: zones,
        provisionable: false,
      }));
    }
    return { offers, skippedNoPrice };
  },
};


// ── OVHcloud ───────────────────────────────────────────────────────────────
// Public order catalogue, no auth — but the shape is unlike every other provider here, and two
// details will silently corrupt the listing if handled naively.
//
// 1. SPECS AND PRICES LIVE IN DIFFERENT ARRAYS. `plans[]` carries planCode + pricings; the
//    cores/RAM/disk are on `products[]`, joined via `plan.product`. A plan with no matching
//    product is an add-on (extra disk, backups, a licence), not a machine.
//
// 2. ONE MACHINE APPEARS ~10 TIMES. Each commitment term and promotion is its own planCode:
//    vps-2025-model3, -degressivity12, -degressivity24, -10percent, and combinations. Listing all
//    of them buries the catalogue in near-duplicates, and taking Math.min() across them quotes a
//    12-month-commitment price as if it were the monthly rate — verified against the live
//    catalogue, where model3 is 19.99 monthly but 16.99 on a 12-month commitment.
//
//    So: only pricings with `commitment === 0` are considered (the true no-commitment monthly
//    rate, comparable to how every other provider here quotes), and offers are de-duplicated by
//    product + price, keeping the shortest planCode — which is always the base plan rather than a
//    promotional variant.
//
// Prices are NET, matching the taxIncluded: false convention the Hetzner adapter documents.
// `ovhSubsidiary` selects the price list; FR is the EUR one.
const OVH_SUBSIDIARY = process.env.OVH_SUBSIDIARY || 'FR';

/**
 * Pure transform of OVH's order catalogue into offers, exported so the join and de-duplication
 * rules can be tested against a fixture — they are intricate and fail SILENTLY, surfacing as a
 * plausible-looking wrong price rather than an error.
 */
export function ovhOffersFromCatalog(data: any): AdapterResult {
    const currency = String(data?.locale?.currencyCode ?? 'EUR');

  // Only products carrying BOTH cpu and memory are machines; the rest are add-ons.
  const specs = new Map<string, { vcpu: number; ramGb: number; diskGb: number }>();
  for (const product of data?.products ?? []) {
    const tech = product?.blobs?.technical;
    const vcpu = Number(tech?.cpu?.cores ?? NaN);
    const ramGb = Number(tech?.memory?.size ?? NaN);
    if (!Number.isFinite(vcpu) || !Number.isFinite(ramGb) || vcpu <= 0 || ramGb <= 0) continue;
    const diskGb = Number(tech?.storage?.disks?.[0]?.capacity ?? 0);
    specs.set(String(product.name), { vcpu, ramGb, diskGb: Number.isFinite(diskGb) ? diskGb : 0 });
  }

  // product|price -> the offer we intend to keep, so promotional variants collapse together.
  const best = new Map<string, { planCode: string; label: string; monthly: number; spec: { vcpu: number; ramGb: number; diskGb: number } }>();
  let skippedNoPrice = 0;

  for (const plan of data?.plans ?? []) {
    const spec = specs.get(String(plan?.product ?? ''));
    if (!spec) continue; // add-on, not a machine

    // Upgrade-path SKUs: `vps-elite-8-8-160-vps-2025-model3` is the price for an existing Elite
    // 8-8-160 customer moving to VPS-3, and it is dearer than ordering VPS-3 outright (34.50 vs
    // 19.99 for identical 8c/24g/200g). In a comparison catalogue that reads as two prices for
    // the same machine, so drop them — a new customer cannot order one anyway.
    // Not anchored to the end: promotional variants append their own suffix, so
    // `vps-elite-8-8-160-vps-2025-model3-10percent` is the same upgrade SKU wearing a discount.
    if (/-vps-\d{4}-model\d+(-|$)/.test(String(plan.planCode))) continue;

    const monthly = (plan?.pricings ?? [])
      .filter((p: any) =>
        Array.isArray(p?.capacities) && p.capacities.includes('renew') &&
        p?.intervalUnit === 'month' && Number(p?.interval) === 1 &&
        Number(p?.commitment ?? 0) === 0)
      // Prices are in nano-units: 1999000000 is 19.99.
      .map((p: any) => Number(p.price) / 1e8)
      .filter((n: number) => Number.isFinite(n) && n > 0)
      .sort((a: number, b: number) => a - b)[0];

    if (monthly === undefined) { skippedNoPrice++; continue; }

    const planCode = String(plan.planCode);
    // Keyed on the PRODUCT alone, so all the commercial ranges and promotional tiers selling the
    // same machine collapse to one row. Keying on product+price does not collapse them, because
    // the whole point of the variants is that they carry different prices.
    const key = String(plan.product);
    const seen = best.get(key);
    // The BASE plan code wins, not the cheapest variant — and it is always the shortest, since
    // every variant is the base code plus a suffix (-degressivity24, -10percent, ...). Taking the
    // minimum instead would advertise a promotional or commitment-linked rate as the standard
    // monthly price: vps-2025-model1 lists at 6.49, but a -degressivity24 variant shows 4.25.
    if (!seen || planCode.length < seen.planCode.length) {
      best.set(key, { planCode, label: String(plan.invoiceName ?? planCode), monthly, spec });
    }
  }

  const offers: VpsOffer[] = [];
  for (const entry of best.values()) {
    offers.push(withDerived({
      provider: 'ovh',
      planId: entry.planCode,
      label: entry.label,
      vcpu: entry.spec.vcpu,
      // The catalogue does not distinguish shared from dedicated vCPU, and OVH's VPS line is
      // shared. Claiming 'dedicated' would make these look like far better value than they are.
      cpuType: 'shared' as VpsCpuType,
      arch: 'x86' as VpsArch,
      ramGb: entry.spec.ramGb,
      diskGb: entry.spec.diskGb,
      priceMonthly: entry.monthly,
      currency,
      taxIncluded: false,
      // Billed monthly, not by the hour — there is no hourly rate to quote.
      hourlyBilling: false,
      locations: [],
      provisionable: false,
    }));
  }
  return { offers, skippedNoPrice };
}

export const ovhAdapter: VpsCatalogAdapter = {
  provider: 'ovh',
  requiresCredentials: false,
  // Cataloguing OVH is easy; ORDERING is not. Unlike Hetzner's single POST /servers with a bearer
  // token, OVH uses a signed cart/order flow with asynchronous delivery, so there is no
  // ProvisionClusterActivity branch for it.
  provisionable: false,
  async fetch() {
    return ovhOffersFromCatalog(
      await getJson(
        `https://api.ovh.com/v1/order/catalog/public/vps?ovhSubsidiary=${encodeURIComponent(OVH_SUBSIDIARY)}`,
      ),
    );
  },
};


// ── InterServer ────────────────────────────────────────────────────────────
// The only provider here that speaks SOAP rather than JSON, and the only one besides Hetzner
// whose API can actually ORDER a machine (api_api_buy_vps). Its catalogue call needs no auth —
// verified live against https://my.interserver.net/api.php.
//
// Priced by "slice": every slice adds a fixed lump of resources, and a plan is just N slices.
// The API returns the COST PER SLICE and which slice types are buyable, but NOT what a slice
// contains — all 119 operations were checked, and none reports RAM or disk. So the ladder below
// is transcribed from the pricing page and pinned by tests.
//
// That is a deliberate, bounded compromise: if InterServer changes the ladder the PRICE stays
// correct (it is derived from the API) and only the specs go stale, which the test makes findable.
const INTERSERVER_ENDPOINT = 'https://my.interserver.net/api.php';

/**
 * Advertised tiers, from https://www.interserver.net/vps/.
 *
 * RAM, disk and transfer scale linearly per slice (2GB / 40GB / 2TB each). vCores do NOT — they
 * are 1 at a single slice and half the slice count above that, which is why this is a table rather
 * than a multiply.
 */
const INTERSERVER_TIERS: readonly { slices: number; vcpu: number }[] = [
  { slices: 1, vcpu: 1 },
  { slices: 4, vcpu: 2 },
  { slices: 8, vcpu: 4 },
  { slices: 16, vcpu: 8 },
  { slices: 32, vcpu: 16 },
];
const GB_RAM_PER_SLICE = 2;
const GB_DISK_PER_SLICE = 40;
const TB_TRANSFER_PER_SLICE = 2;

/**
 * Pure parse of the get_vps_slice_types SOAP response, exported so the XML handling and the
 * slice-type filtering can be tested without a network call.
 *
 * Hand-parsed rather than pulling in a SOAP client: this is one fixed rpc/encoded response with a
 * flat shape, and a dependency for a single endpoint is a worse trade than a tested regex.
 */
export function interserverOffersFromSliceXml(xml: string): AdapterResult {
  const offers: VpsOffer[] = [];
  let skippedNoPrice = 0;

  for (const item of xml.match(/<item[^>]*>[\s\S]*?<\/item>/g) ?? []) {
    const field = (name: string): string | undefined =>
      new RegExp(`<${name}[^>]*>([^<]*)</${name}>`).exec(item)?.[1]?.trim();

    const name = field('name');
    const costPerSlice = Number(field('cost'));
    if (!name) continue;
    if (!Number.isFinite(costPerSlice) || costPerSlice <= 0) { skippedNoPrice++; continue; }

    // Not orderable — listing it invites picking a plan that cannot be bought.
    if (field('buyable') !== '1') continue;

    // Windows costs more and cannot run k3s; "Storage" slices are disk add-ons, not machines.
    if (/windows|hyper-v|storage/i.test(name)) continue;

    // IPv6-only variants are cheaper and genuinely tempting, but this platform reaches a machine
    // over IPv4 — SSH bootstrap and the 100.64.0.0/10 mesh both assume it — so an IPv6-only box
    // would be catalogued as usable and then be unreachable.
    if (/ipv6/i.test(name)) continue;

    // OpenVZ and Virtuozzo are container virtualisation, kept because this is a general VPS
    // catalogue, but labelled so the distinction is visible: nested containers there frequently
    // cannot run k3s, whereas KVM is full virtualisation and can.
    for (const tier of INTERSERVER_TIERS) {
      offers.push(withDerived({
        provider: 'interserver',
        planId: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${tier.slices}`,
        label: `${name} × ${tier.slices}`,
        vcpu: tier.vcpu,
        cpuType: 'shared' as VpsCpuType,
        arch: 'x86' as VpsArch,
        ramGb: GB_RAM_PER_SLICE * tier.slices,
        diskGb: GB_DISK_PER_SLICE * tier.slices,
        priceMonthly: Number((costPerSlice * tier.slices).toFixed(2)),
        bandwidthTb: TB_TRANSFER_PER_SLICE * tier.slices,
        currency: 'USD',
        // US providers quote pre-tax, matching the convention the Hetzner adapter documents.
        taxIncluded: false,
        hourlyBilling: false,
        // get_vps_locations_array would fill this, but it is a second SOAP round trip for data the
        // catalogue does not filter on yet.
        locations: [],
        provisionable: false,
      }));
    }
  }
  return { offers, skippedNoPrice };
}

export const interserverAdapter: VpsCatalogAdapter = {
  provider: 'interserver',
  requiresCredentials: false,
  // api_api_buy_vps exists, so this could become true — but ordering is a separate job from
  // cataloguing, and nothing in ProvisionClusterActivity targets InterServer yet.
  provisionable: false,
  async fetch() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(INTERSERVER_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:myapi#get_vps_slice_types' },
        body:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:myapi">' +
          '<soap:Body><urn:get_vps_slice_types/></soap:Body></soap:Envelope>',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return interserverOffersFromSliceXml(await res.text());
    } finally {
      clearTimeout(timer);
    }
  },
};

export const ADAPTERS: readonly VpsCatalogAdapter[] = [
  hetznerAdapter,
  linodeAdapter,
  vultrAdapter,
  digitalOceanAdapter,
  scalewayAdapter,
  ovhAdapter,
  interserverAdapter,
];
