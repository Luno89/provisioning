import { describe, expect, it } from 'vitest';
import { VpsCatalogService } from '../services/VpsCatalogService.js';
import type { AdapterResult, VpsCatalogAdapter, VpsOffer } from '../lib/vps-catalog/types.js';
import { withDerived } from '../lib/vps-catalog/types.js';

export const offer = (o: Partial<Parameters<typeof withDerived>[0]> = {}): VpsOffer =>
  withDerived({
    provider: 'test', planId: 'p1', label: 'P1',
    vcpu: 2, cpuType: 'shared', arch: 'x86',
    ramGb: 4, diskGb: 80,
    priceMonthly: 20, currency: 'USD', taxIncluded: false,
    hourlyBilling: true, locations: ['us-east'],
    ...o,
  });

export const good = (provider: string): VpsCatalogAdapter => ({
  provider,
  fetch: async () => ({ offers: [offer({ provider, planId: `${provider}-1` })], skippedNoPrice: 0 }),
});

export function vpsCatalogBehaviour(): void {
  describe('one bad provider must not empty the whole catalogue', () => {
    const svc = (adapters: VpsCatalogAdapter[]) => new VpsCatalogService(adapters);

    it('still returns healthy providers when one adapter throws', async () => {
      const boom: VpsCatalogAdapter = {
        provider: 'boom',
        fetch: async () => { throw new Error('upstream 503'); },
      };
      const r = await svc([good('linode'), boom, good('vultr')]).search({});
      expect(r.offers.map((o) => o.provider).sort()).toEqual(['linode', 'vultr']);
      expect(r.sources.find((s) => s.provider === 'boom')).toMatchObject({
        status: 'error', offerCount: 0, message: 'upstream 503',
      });
    });

    it('survives an adapter whose result shape is wrong, and does not poison the cache', async () => {
      const malformed: VpsCatalogAdapter = {
        provider: 'malformed',
        fetch: async () => JSON.parse(JSON.stringify([offer({ provider: 'malformed' })])) as AdapterResult,
      };
      const s = svc([good('linode'), malformed]);

      const first = await s.search({});
      expect(first.offers.map((o) => o.provider)).toEqual(['linode']);
      expect(first.sources.find((x) => x.provider === 'malformed')?.status).toBe('error');

      const second = await s.search({});
      expect(second.offers.map((o) => o.provider)).toEqual(['linode']);
      expect(second.sources.find((x) => x.provider === 'malformed')?.status).toBe('error');
    });
  });

  describe('the market a provider was read for', () => {
    const au: VpsCatalogAdapter = {
      provider: 'ovh',
      fetch: async () => ({
        offers: [offer({ provider: 'ovh', planId: 'vps-2027-model2', currency: 'AUD' })],
        skippedNoPrice: 0,
        market: { subsidiary: 'AU', currency: 'AUD', taxRate: 10 },
      }),
    };

    it('is carried on the source, fresh and from the cache', async () => {
      const s = new VpsCatalogService([au]);
      const fresh = await s.search({});
      expect(fresh.sources[0]).toMatchObject({ provider: 'ovh', cached: false, market: { subsidiary: 'AU', currency: 'AUD', taxRate: 10 } });
      const cached = await s.search({});
      expect(cached.sources[0]).toMatchObject({ cached: true, market: { subsidiary: 'AU', currency: 'AUD' } });
    });

    it('is left out for a provider that names none', async () => {
      const plain: VpsCatalogAdapter = {
        provider: 'vultr',
        fetch: async () => ({ offers: [offer({ provider: 'vultr' })], skippedNoPrice: 0 }),
      };
      const r = await new VpsCatalogService([plain]).search({});
      expect(r.sources[0]).not.toHaveProperty('market');
    });
  });

  describe('each provider\'s public price list', () => {
    const counted = () => {
      let asked = 0;
      const adapter: VpsCatalogAdapter = {
        provider: 'vultr',
        fetch: async () => { asked += 1; return { offers: [offer({ provider: 'vultr', planId: `vc-${asked}` })], skippedNoPrice: 0 }; },
      };
      return { adapter, asked: () => asked };
    };

    it('is read with no credentials and answered from the cache, the same for every caller, until the cache is cleared', async () => {
      const { adapter, asked } = counted();
      const svc = new VpsCatalogService([adapter]);
      expect((await svc.search({})).offers.map((o) => o.planId)).toEqual(['vc-1']);
      expect((await svc.search({ minRamGb: 1 })).sources[0]).toMatchObject({ provider: 'vultr', status: 'ok', cached: true });
      expect(asked()).toBe(1);
      svc.clearCache();
      expect((await svc.search({})).offers.map((o) => o.planId)).toEqual(['vc-2']);
      expect(asked()).toBe(2);
    });
  });
}
