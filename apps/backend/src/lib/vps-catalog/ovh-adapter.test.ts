import { describe, it, expect } from 'vitest';
import { ovhOffersFromCatalog } from './adapters.js';

const price = (eur: number, commitment = 0) => ({
  capacities: ['renew'],
  commitment,
  interval: 1,
  intervalUnit: 'month',
  price: eur * 1e8,
  tax: eur * 0.2 * 1e8,
});

const catalogue = {
  locale: { currencyCode: 'EUR' },
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
});
