import { providerReady } from '../cluster-topology.js';
import { at, listAt, recordAt } from '../json-reading.js';
import { withDerived, type AdapterResult, type VpsArch, type VpsCatalogAdapter, type VpsCpuType, type VpsOffer, type VpsPricePart } from './types.js';

const TIMEOUT_MS = 15_000;

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
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

export const linodeAdapter: VpsCatalogAdapter = {
  provider: 'linode',
  requiresCredentials: false,
  provisionable: providerReady('linode'),
  async fetch() {
    const data = await getJson('https://api.linode.com/v4/linode/types');
    const offers: VpsOffer[] = [];
    let skippedNoPrice = 0;
    for (const item of listAt(data, 'data')) {
      const p = recordAt(item);
      const monthly = at(p, 'price', 'monthly');
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
        ...(Number(p.gpus ?? 0) > 0 ? { gpuCount: Number(p.gpus) } : {}),
        ...(Number(p.gpus ?? 0) > 0 && /\+\s*([A-Za-z0-9]+)\s*GPU/i.exec(String(p.label ?? ''))
          ? { gpuModel: /\+\s*([A-Za-z0-9]+)\s*GPU/i.exec(String(p.label))![1]! }
          : {}),
        priceMonthly: monthly,
        ...(typeof at(p, 'price', 'hourly') === 'number' ? { priceHourly: Number(at(p, 'price', 'hourly')) } : {}),
        currency: 'USD',
        taxIncluded: false,
        hourlyBilling: true,
        locations: [],
        provisionable: providerReady('linode'),
      }));
    }
    return { offers, skippedNoPrice };
  },
};

export const vultrAdapter: VpsCatalogAdapter = {
  provider: 'vultr',
  requiresCredentials: false,
  provisionable: providerReady('vultr'),
  async fetch() {
    const data = await getJson('https://api.vultr.com/v2/plans?per_page=500');
    const offers: VpsOffer[] = [];
    let skippedNoPrice = 0;
    for (const item of listAt(data, 'plans')) {
      const p = recordAt(item);
      const monthly = Number(p.monthly_cost ?? 0);
      if (!monthly) { skippedNoPrice++; continue; }

      const family = String(p.type ?? '');
      const cpuType: VpsCpuType =
        family === 'vdm' || family === 'voc' || family === 'vcg' ? 'dedicated'
        : family === 'vc2' || family === 'vhf' || family === 'vhp' ? 'shared'
        : 'unknown';

      const vendor = String(p.cpu_vendor ?? '').toLowerCase();
      const arch: VpsArch = vendor.includes('ampere') || vendor.includes('arm') ? 'arm' : 'x86';

      const gpuBrand = String(p.gpu_brand ?? '').trim();
      const hasGpu = gpuBrand !== '' && gpuBrand.toLowerCase() !== 'none';
      const vramMatch = /-(\d+)vram(?:-|$)/.exec(String(p.id ?? ''));
      const gpuVramGb = hasGpu && vramMatch?.[1] ? Number(vramMatch[1]) : undefined;

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
        ...(p.bandwidth ? { bandwidthTb: Number(p.bandwidth) / 1000 } : {}),
        ...(hasGpu ? { gpuModel: gpuBrand } : {}),
        ...(gpuVramGb !== undefined ? { gpuVramGb } : {}),
        priceMonthly: monthly,
        ...(typeof p.hourly_cost === 'number' ? { priceHourly: p.hourly_cost } : {}),
        currency: 'USD',
        taxIncluded: false,
        hourlyBilling: true,
        locations: listAt(p, 'locations').map(String),
        provisionable: providerReady('vultr'),
      }));
    }
    return { offers, skippedNoPrice };
  },
};

export const hetznerAdapter: VpsCatalogAdapter = {
  provider: 'hetzner',
  requiresCredentials: true,
  provisionable: providerReady('hetzner'),
  async fetch(token?: string) {
    if (!token) return { offers: [], skippedNoPrice: 0 };
    const data = await getJson('https://api.hetzner.cloud/v1/server_types?per_page=100', {
      Authorization: `Bearer ${token}`,
    });
    const offers: VpsOffer[] = [];
    let skippedNoPrice = 0;
    for (const item of listAt(data, 'server_types')) {
      const st = recordAt(item);
      if (st.deprecated) continue;

      const prices = listAt(st, 'prices');

      const tiers = new Map<string, { monthly: number; hourly?: number; traffic?: number; locations: string[] }>();
      for (const p of prices) {
        const monthly = Number(at(p, 'price_monthly', 'net') ?? NaN);
        if (!Number.isFinite(monthly) || monthly <= 0) continue;
        const hourly = Number(at(p, 'price_hourly', 'net') ?? NaN);
        const traffic = Number(at(p, 'included_traffic') ?? NaN);
        const location = String(at(p, 'location') ?? '');
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
          ...(multiTier && locations[0] ? { idSuffix: locations[0] } : {}),
          label: `${String(st.name).toUpperCase()} — ${String(st.description ?? '')}`.trim(),
          vcpu: Number(st.cores ?? 0),
          cpuType: String(st.cpu_type ?? '') === 'dedicated' ? 'dedicated' : 'shared',
          arch,
          ramGb: Number(st.memory ?? 0),
          diskGb: Number(st.disk ?? 0),
          priceMonthly: tier.monthly,
          ...(tier.hourly ? { priceHourly: tier.hourly } : {}),
          ...(tier.traffic ? { bandwidthTb: tier.traffic / 2 ** 40 } : {}),
          currency: 'EUR',
          taxIncluded: false,
          hourlyBilling: true,
          locations,
          provisionable: providerReady('hetzner'),
        }));
      }
    }
    return { offers, skippedNoPrice };
  },
};

export const digitalOceanAdapter: VpsCatalogAdapter = {
  provider: 'do',
  requiresCredentials: true,
  provisionable: providerReady('do'),
  async fetch(token?: string) {
    if (!token) return { offers: [], skippedNoPrice: 0 };
    const data = await getJson('https://api.digitalocean.com/v2/sizes?per_page=200', {
      Authorization: `Bearer ${token}`,
    });
    const offers: VpsOffer[] = [];
    let skippedNoPrice = 0;
    for (const item of listAt(data, 'sizes')) {
      const s = recordAt(item);
      if (s.available === false) continue;
      const monthly = Number(s.price_monthly ?? 0);
      if (!monthly) { skippedNoPrice++; continue; }

      const slug = String(s.slug ?? '');
      offers.push(withDerived({
        provider: 'do',
        planId: slug,
        label: String(s.description ?? slug),
        vcpu: Number(s.vcpus ?? 0),
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
        locations: listAt(s, 'regions').map(String),
        provisionable: providerReady('do'),
      }));
    }
    return { offers, skippedNoPrice };
  },
};

const SCALEWAY_ZONES = ['fr-par-1', 'fr-par-2', 'nl-ams-1', 'pl-waw-1'] as const;

export const scalewayAdapter: VpsCatalogAdapter = {
  provider: 'scaleway',
  requiresCredentials: false,
  provisionable: providerReady('scaleway'),
  async fetch() {
    const byPlan = new Map<string, { raw: Record<string, unknown>; zones: string[] }>();

    const results = await Promise.allSettled(
      SCALEWAY_ZONES.map(async (z) => ({
        zone: z,
        data: await getJson(`https://api.scaleway.com/instance/v1/zones/${z}/products/servers`),
      })),
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const [name, raw] of Object.entries(recordAt(r.value.data, 'servers'))) {
        const existing = byPlan.get(name);
        if (existing) existing.zones.push(r.value.zone);
        else byPlan.set(name, { raw: recordAt(raw), zones: [r.value.zone] });
      }
    }

    const offers: VpsOffer[] = [];
    let skippedNoPrice = 0;
    for (const [name, { raw, zones }] of byPlan) {
      if (raw.end_of_service) continue;
      const monthly = Number(raw.monthly_price ?? 0);
      if (!monthly) { skippedNoPrice++; continue; }

      offers.push(withDerived({
        provider: 'scaleway',
        planId: name,
        label: name,
        vcpu: Number(raw.ncpus ?? 0),
        cpuType: 'unknown',
        arch: String(raw.arch ?? '') === 'arm64' ? 'arm' : 'x86',
        ramGb: Math.round(Number(raw.ram ?? 0) / 1024 ** 3),
        diskGb: Math.round(Number(at(raw, 'per_volume_constraint', 'l_ssd', 'max_size') ?? 0) / 1024 ** 3),
        ...(Number(raw.gpu ?? 0) > 0 ? { gpuCount: Number(raw.gpu) } : {}),
        ...(at(raw, 'gpu_info', 'gpu_memory')
          ? {
              gpuVramGb: Math.round(
                (Number(at(raw, 'gpu_info', 'gpu_memory')) / 1024 ** 3) * Math.max(1, Number(raw.gpu ?? 1)),
              ),
            }
          : {}),
        ...(at(raw, 'gpu_info', 'gpu_name')
          ? { gpuModel: `${String(at(raw, 'gpu_info', 'gpu_manufacturer') ?? '')} ${String(at(raw, 'gpu_info', 'gpu_name'))}`.trim() }
          : {}),
        priceMonthly: monthly,
        ...(typeof raw.hourly_price === 'number' ? { priceHourly: raw.hourly_price } : {}),
        currency: 'EUR',
        taxIncluded: false,
        hourlyBilling: true,
        locations: zones,
        provisionable: providerReady('scaleway'),
      }));
    }
    return { offers, skippedNoPrice };
  },
};

const OVH_HOSTS: readonly { host: string; subsidiaries: readonly string[] }[] = [
  { host: 'https://ca.api.ovh.com/1.0', subsidiaries: ['ASIA', 'AU', 'CA', 'IN', 'QC', 'SG', 'WE', 'WS'] },
  { host: 'https://eu.api.ovh.com/1.0', subsidiaries: ['CZ', 'DE', 'ES', 'EU', 'FI', 'FR', 'GB', 'IE', 'IT', 'LT', 'MA', 'NL', 'PL', 'PT', 'SN', 'TN'] },
  { host: 'https://api.us.ovhcloud.com/1.0', subsidiaries: ['US'] },
];

export const OVH_SUBSIDIARIES: readonly string[] = OVH_HOSTS.flatMap((h) => h.subsidiaries);

export function ovhHostFor(subsidiary: string): string {
  const wanted = subsidiary.trim().toUpperCase();
  const found = OVH_HOSTS.find((h) => h.subsidiaries.includes(wanted));
  if (!found) {
    throw new Error(
      `OVH_SUBSIDIARY=${subsidiary} is not an OVHcloud subsidiary; known ones are ${OVH_SUBSIDIARIES.join(', ')}`,
    );
  }
  return found.host;
}

export const OVH_ORDERABLE_TAG = 'order-funnel:show';

export const ovhOrderable = (plan: { blobs?: { tags?: unknown } } | undefined): boolean =>
  Array.isArray(plan?.blobs?.tags) && plan.blobs.tags.includes(OVH_ORDERABLE_TAG);

export function ovhCatalogUrl(subsidiary: string): string {
  return `${ovhHostFor(subsidiary)}/order/catalog/public/vps?ovhSubsidiary=${encodeURIComponent(subsidiary.trim().toUpperCase())}`;
}

const OVH_FAMILY_LABELS: Record<string, string> = {
  automatedBackup: 'backup',
  os: 'OS',
  additionalDisk: 'extra disk',
};

function ovhMonthlyOf(pricings: unknown): number | undefined {
  return listAt(pricings)
    .map((p) => recordAt(p))
    .filter((p) =>
      listAt(p, 'capacities').includes('renew') &&
      p.intervalUnit === 'month' && Number(p.interval) === 1 &&
      Number(p.commitment ?? 0) === 0)
    .map((p) => Number(p.price) / 1e8)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b)[0];
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function ovhOffersFromCatalog(data: unknown): AdapterResult {
  const locale = recordAt(data, 'locale');
  const currency = locale.currencyCode === undefined ? undefined : String(locale.currencyCode);
  const subsidiary = locale.subsidiary === undefined ? undefined : String(locale.subsidiary);
  const taxRate = Number(locale.taxRate);

  const specs = new Map<string, { vcpu: number; ramGb: number; diskGb: number }>();
  for (const product of listAt(data, 'products')) {
    const tech = at(product, 'blobs', 'technical');
    const vcpu = Number(at(tech, 'cpu', 'cores') ?? NaN);
    const ramGb = Number(at(tech, 'memory', 'size') ?? NaN);
    if (!Number.isFinite(vcpu) || !Number.isFinite(ramGb) || vcpu <= 0 || ramGb <= 0) continue;
    const diskGb = Number(at(tech, 'storage', 'disks', 0, 'capacity') ?? 0);
    specs.set(String(at(product, 'name')), { vcpu, ramGb, diskGb: Number.isFinite(diskGb) ? diskGb : 0 });
  }

  const optionPrices = new Map<string, number>();
  for (const addon of listAt(data, 'addons')) {
    const monthly = ovhMonthlyOf(at(addon, 'pricings'));
    const addonCode = at(addon, 'planCode');
    if (addonCode !== undefined && monthly !== undefined) optionPrices.set(String(addonCode), monthly);
  }

  interface Best {
    planCode: string;
    label: string;
    monthly: number;
    options: VpsPricePart[];
    locations: string[];
    spec: { vcpu: number; ramGb: number; diskGb: number };
  }
  const best = new Map<string, Best>();
  let skippedNoPrice = 0;

  for (const item of listAt(data, 'plans')) {
    const plan = recordAt(item);
    const spec = specs.get(String(plan.product ?? ''));
    if (!spec) continue;

    if (/-vps-\d{4}-model\d+(-|$)/.test(String(plan.planCode))) continue;
    if (!ovhOrderable(plan)) continue;

    const planMonthly = ovhMonthlyOf(plan.pricings);
    if (planMonthly === undefined || planMonthly <= 0) { skippedNoPrice++; continue; }

    const planCode = String(plan.planCode);
    const options: VpsPricePart[] = [];
    for (const familyItem of listAt(plan, 'addonFamilies')) {
      const family = recordAt(familyItem);
      if (family.mandatory !== true) continue;
      const priced = listAt(family, 'addons')
        .map((code) => ({ code: String(code), amount: optionPrices.get(String(code)) }))
        .filter((o): o is { code: string; amount: number } => o.amount !== undefined)
        .sort((a, b) => a.amount - b.amount);
      const cheapest = priced[0];
      if (!cheapest || cheapest.amount <= 0) continue;
      const familyName = String(family.name ?? cheapest.code);
      options.push({ label: OVH_FAMILY_LABELS[familyName] ?? familyName, planCode: cheapest.code, amount: cheapest.amount });
    }

    const locations = listAt(plan, 'configurations')
      .filter((c) => at(c, 'name') === 'vps_datacenter')
      .flatMap((c) => listAt(c, 'values').map(String))
      .sort();

    const key = String(plan.product);
    const seen = best.get(key);
    if (!seen || planCode.length < seen.planCode.length) {
      best.set(key, {
        planCode,
        label: String(plan.invoiceName ?? planCode),
        monthly: planMonthly,
        options,
        locations,
        spec,
      });
    }
  }

  if (!currency) {
    if (best.size > 0) throw new Error('the OVHcloud catalog names no currency (locale.currencyCode)');
    return { offers: [], skippedNoPrice };
  }

  const offers: VpsOffer[] = [];
  for (const entry of best.values()) {
    const planCode = entry.planCode;
    offers.push(withDerived({
      provider: 'ovh',
      planId: entry.planCode,
      label: entry.label,
      vcpu: entry.spec.vcpu,
      cpuType: 'shared' as VpsCpuType,
      arch: 'x86' as VpsArch,
      ramGb: entry.spec.ramGb,
      diskGb: entry.spec.diskGb,
      priceMonthly: cents(entry.options.reduce((sum, part) => sum + part.amount, entry.monthly)),
      ...(entry.options.length > 0
        ? { priceParts: [{ label: 'plan', planCode, amount: entry.monthly }, ...entry.options] }
        : {}),
      currency,
      taxIncluded: false,
      hourlyBilling: false,
      locations: entry.locations,
      provisionable: providerReady('ovh'),
    }));
  }

  return {
    offers,
    skippedNoPrice,
    ...(subsidiary ? { market: { subsidiary, currency, ...(Number.isFinite(taxRate) ? { taxRate } : {}) } } : {}),
  };
}

export const OVH_DEFAULT_SUBSIDIARY = 'FR';

export function ovhAdapterFor(subsidiary: string | (() => string)): VpsCatalogAdapter {
  const subsidiaryNow = typeof subsidiary === 'function' ? subsidiary : () => subsidiary;
  return {
    provider: 'ovh',
    requiresCredentials: false,
    provisionable: providerReady('ovh'),
    async fetch() {
      return ovhOffersFromCatalog(await getJson(ovhCatalogUrl(subsidiaryNow())));
    },
  };
}

export const ovhSubsidiaryFrom = (env: Readonly<Record<string, string | undefined>>): string => env.OVH_SUBSIDIARY?.trim() || OVH_DEFAULT_SUBSIDIARY;

const INTERSERVER_ENDPOINT = 'https://my.interserver.net/api.php';

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

    if (field('buyable') !== '1') continue;

    if (/windows|hyper-v|storage/i.test(name)) continue;

    if (/ipv6/i.test(name)) continue;

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
        taxIncluded: false,
        hourlyBilling: false,
        locations: [],
        provisionable: providerReady('interserver'),
      }));
    }
  }
  return { offers, skippedNoPrice };
}

export const interserverAdapter: VpsCatalogAdapter = {
  provider: 'interserver',
  requiresCredentials: false,
  provisionable: providerReady('interserver'),
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

export function vpsCatalogAdapters(ovhSubsidiary: () => string): readonly VpsCatalogAdapter[] {
  return [
    hetznerAdapter,
    linodeAdapter,
    vultrAdapter,
    digitalOceanAdapter,
    scalewayAdapter,
    ovhAdapterFor(ovhSubsidiary),
    interserverAdapter,
  ];
}
