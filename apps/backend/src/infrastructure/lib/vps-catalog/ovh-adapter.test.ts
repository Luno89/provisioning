import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OVH_DEFAULT_SUBSIDIARY, OVH_SUBSIDIARIES, ovhCatalogUrl, ovhHostFor, ovhOffersFromCatalog, ovhSubsidiaryFrom } from './adapters.js';

const auCatalog = JSON.parse(readFileSync(new URL('./ovh-au-catalog.json', import.meta.url), 'utf8'));

const price = (eur: number, commitment = 0) => ({
  capacities: ['renew'],
  commitment,
  interval: 1,
  intervalUnit: 'month',
  price: eur * 1e8,
  tax: eur * 0.2 * 1e8,
});

const catalogue = {
  locale: { currencyCode: 'EUR', subsidiary: 'FR', taxRate: 20 },
  products: [
    { name: 'vps-2025-model3', blobs: { technical: { cpu: { cores: 8 }, memory: { size: 24 }, storage: { disks: [{ capacity: 200 }] } } } },
    { name: 'vps-2025-model1', blobs: { technical: { cpu: { cores: 4 }, memory: { size: 8 }, storage: { disks: [{ capacity: 75 }] } } } },
    { name: 'vps-option-additional-disk-50g', blobs: { technical: { storage: { disks: [{ capacity: 50 }] } } } },
    { name: 'vps-option-backup', blobs: null },
  ],
  plans: [
    { planCode: 'vps-2025-model3', product: 'vps-2025-model3', invoiceName: 'VPS-3 2026',
      pricings: [price(19.99, 0), price(16.99, 12), price(18.99, 6)] },
    { planCode: 'vps-2025-model3-10percent', product: 'vps-2025-model3', invoiceName: 'VPS-3 2026',
      pricings: [price(17.99, 0)] },
    { planCode: 'vps-elite-8-8-160-vps-2025-model3', product: 'vps-2025-model3', invoiceName: 'VPS-3 2026',
      pricings: [price(34.5, 0)] },
    { planCode: 'vps-elite-8-8-160-vps-2025-model3-10percent', product: 'vps-2025-model3', invoiceName: 'VPS-3 2026',
      pricings: [price(33.0, 0)] },
    { planCode: 'vps-2025-model1', product: 'vps-2025-model1', invoiceName: 'VPS-1 2026',
      pricings: [price(6.49, 0)] },
    { planCode: 'vps-option-additional-disk-50g', product: 'vps-option-additional-disk-50g', pricings: [price(3, 0)] },
    { planCode: 'vps-committed-only', product: 'vps-2025-model1', pricings: [price(4.0, 24)] },
  ],
};

describe('ovhOffersFromCatalog', () => {
  const { offers, skippedNoPrice } = ovhOffersFromCatalog(catalogue);
  const byId = (planId: string) => offers.find((o) => o.planId === planId);

  it('joins specs from products onto plans', () => {
    expect(byId('vps-2025-model3')).toMatchObject({ vcpu: 8, ramGb: 24, diskGb: 200 });
    expect(byId('vps-2025-model1')).toMatchObject({ vcpu: 4, ramGb: 8, diskGb: 75 });
  });

  it('quotes the NO-COMMITMENT monthly price, not the cheapest tier', () => {
    expect(byId('vps-2025-model3')?.priceMonthly).toBe(19.99);
  });

  it('collapses promotional variants of the same machine to the base plan', () => {
    const model3 = offers.filter((o) => o.ramGb === 24);
    expect(model3).toHaveLength(1);
    expect(model3[0]!.planId).toBe('vps-2025-model3');
  });

  it('drops upgrade-path SKUs, including promo-suffixed ones', () => {
    expect(offers.some((o) => o.planId.includes('vps-elite-8-8-160'))).toBe(false);
  });

  it('never turns an add-on into a machine', () => {
    expect(offers.some((o) => o.planId.includes('option'))).toBe(false);
  });

  it('counts a commitment-only plan as unpriced rather than pricing it', () => {
    expect(skippedNoPrice).toBe(1);
  });

  it('reports NET prices, matching the convention the other adapters use', () => {
    expect(byId('vps-2025-model3')?.taxIncluded).toBe(false);
    expect(byId('vps-2025-model3')?.currency).toBe('EUR');
  });

  it('marks OVH as not provisionable, because only the catalogue is wired up', () => {
    expect(offers.every((o) => o.provisionable === false)).toBe(true);
  });

  it('does not claim dedicated vCPU it cannot verify', () => {
    expect(offers.every((o) => o.cpuType === 'shared')).toBe(true);
  });

  it('derives price per GB of RAM', () => {
    expect(byId('vps-2025-model3')?.pricePerGbRam).toBeCloseTo(19.99 / 24, 4);
  });

  it('survives an empty or malformed catalogue', () => {
    expect(ovhOffersFromCatalog({}).offers).toEqual([]);
    expect(ovhOffersFromCatalog({ plans: [], products: [] }).offers).toEqual([]);
    expect(() => ovhOffersFromCatalog(undefined)).not.toThrow();
  });

  it('refuses to price plans when the catalogue names no currency', () => {
    expect(() => ovhOffersFromCatalog({ ...catalogue, locale: {} })).toThrow(/currency/);
  });

  it('says which market it read, from the answer', () => {
    expect(ovhOffersFromCatalog(catalogue).market).toEqual({ subsidiary: 'FR', currency: 'EUR', taxRate: 20 });
    expect(ovhOffersFromCatalog({}).market).toBeUndefined();
  });

  it('leaves the plan price alone when its mandatory options cost nothing or are not in the catalogue', () => {
    expect(byId('vps-2025-model3')?.priceParts).toBeUndefined();
  });
});

describe('the host that serves a subsidiary', () => {
  it('sends an Australian account to the CA API, with the rest of its set', () => {
    for (const s of ['ASIA', 'AU', 'CA', 'IN', 'QC', 'SG', 'WE', 'WS']) {
      expect(ovhHostFor(s)).toBe('https://ca.api.ovh.com/1.0');
    }
  });

  it('sends the European subsidiaries to the EU API and the US to its own', () => {
    for (const s of ['CZ', 'DE', 'ES', 'EU', 'FI', 'FR', 'GB', 'IE', 'IT', 'LT', 'MA', 'NL', 'PL', 'PT', 'SN', 'TN']) {
      expect(ovhHostFor(s)).toBe('https://eu.api.ovh.com/1.0');
    }
    expect(ovhHostFor('US')).toBe('https://api.us.ovhcloud.com/1.0');
  });

  it('takes the subsidiary however it is cased', () => {
    expect(ovhHostFor(' au ')).toBe('https://ca.api.ovh.com/1.0');
    expect(ovhCatalogUrl('au')).toBe('https://ca.api.ovh.com/1.0/order/catalog/public/vps?ovhSubsidiary=AU');
  });

  it('refuses an unknown subsidiary, naming the known ones', () => {
    expect(() => ovhHostFor('NZ')).toThrow(/OVH_SUBSIDIARY=NZ is not an OVHcloud subsidiary; known ones are ASIA, AU, CA/);
    expect(() => ovhHostFor('')).toThrow(new RegExp(OVH_SUBSIDIARIES.join(', ')));
  });
});

describe('the AU catalogue (ca.api.ovh.com, ovhSubsidiary=AU, fetched 2026-10-23)', () => {
  const { offers, market } = ovhOffersFromCatalog(auCatalog);
  const byId = (planId: string) => offers.find((o) => o.planId === planId);

  it('was read for AU in AUD with 10% GST', () => {
    expect(market).toEqual({ subsidiary: 'AU', currency: 'AUD', taxRate: 10 });
  });

  it('lists the 2027 models and the starter by their planCode', () => {
    expect(offers.map((o) => o.planId).sort()).toEqual(['vps-2027-model1', 'vps-2027-model2', 'vps-starter-1-2-20']);
    expect(byId('vps-2027-model2')).toMatchObject({ label: 'VPS-2 2027', vcpu: 4, ramGb: 8, diskGb: 75 });
  });

  it('prices in AUD before tax', () => {
    expect(offers.every((o) => o.currency === 'AUD' && o.taxIncluded === false)).toBe(true);
  });

  it('offers Sydney among the datacenters', () => {
    expect(byId('vps-2027-model2')?.locations).toContain('SYD');
    expect(byId('vps-2027-model1')?.locations).toContain('SYD');
    expect(byId('vps-starter-1-2-20')?.locations).toEqual(['BHS', 'DE', 'GRA', 'SBG', 'SGP', 'SYD', 'UK', 'WAW']);
  });

  it('adds the cheapest priced mandatory option of each family to the monthly price', () => {
    const model2 = byId('vps-2027-model2')!;
    expect(model2.priceMonthly).toBe(14.9);
    expect(model2.priceParts).toEqual([
      { label: 'plan', planCode: 'vps-2027-model2', amount: 14 },
      { label: 'backup', planCode: 'option-auto-backup-2027-1-model2', amount: 0.9 },
    ]);
    expect(model2.pricePerGbRam).toBeCloseTo(14.9 / 8, 4);

    const model1 = byId('vps-2027-model1')!;
    expect(model1.priceMonthly).toBe(8);
    expect(model1.priceParts?.map((p) => p.planCode)).toEqual(['vps-2027-model1', 'option-auto-backup-2027-1-model1']);
  });

  it('counts a free mandatory option (Linux, local storage) as no part at all', () => {
    const labels = byId('vps-2027-model2')!.priceParts!.map((p) => p.label);
    expect(labels).not.toContain('OS');
    expect(labels).not.toContain('storage');
  });

  it('lets a plan whose mandatory options are all free keep its own price', () => {
    expect(byId('vps-starter-1-2-20')).toMatchObject({ priceMonthly: 5.75 });
    expect(byId('vps-starter-1-2-20')?.priceParts).toBeUndefined();
  });

  it('reads the subsidiary from the env when the catalog is fetched, after dotenv has run, and falls back to FR', () => {
    expect(ovhSubsidiaryFrom({})).toBe(OVH_DEFAULT_SUBSIDIARY);
    expect(ovhSubsidiaryFrom({ OVH_SUBSIDIARY: '' })).toBe('FR');
    expect(ovhSubsidiaryFrom({ OVH_SUBSIDIARY: ' AU ' })).toBe('AU');
    expect(ovhCatalogUrl(ovhSubsidiaryFrom({ OVH_SUBSIDIARY: 'AU' }))).toContain('ca.api.ovh.com');
  });
});
