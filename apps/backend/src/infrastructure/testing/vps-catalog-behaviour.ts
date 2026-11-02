import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../platform/lib/db-interface.js';
import { encryptValue } from '../../platform/lib/crypto.js';
import { VpsCatalogService } from '../services/VpsCatalogService.js';
import type { AdapterResult, VpsCatalogAdapter, VpsOffer } from '../lib/vps-catalog/types.js';
import { withDerived } from '../lib/vps-catalog/types.js';

export const offer = (o: Partial<Parameters<typeof withDerived>[0]> = {}): VpsOffer =>
  withDerived({
    provider: 'test', planId: 'p1', label: 'P1',
    vcpu: 2, cpuType: 'shared', arch: 'x86',
    ramGb: 4, diskGb: 80,
    priceMonthly: 20, currency: 'USD', taxIncluded: false,
    hourlyBilling: true, locations: ['us-east'], provisionable: false,
    ...o,
  });

export const good = (provider: string): VpsCatalogAdapter => ({
  provider, requiresCredentials: false, provisionable: false,
  fetch: async () => ({ offers: [offer({ provider, planId: `${provider}-1` })], skippedNoPrice: 0 }),
});

const KEY = 'test-key';

export function vpsCatalogBehaviour(make: () => Promise<Database>): void {
  describe('one bad provider must not empty the whole catalogue', () => {
    let db: Database;
    beforeEach(async () => { db = await make(); });

    const svc = (adapters: VpsCatalogAdapter[]) => new VpsCatalogService(db, KEY, adapters);

    it('still returns healthy providers when one adapter throws', async () => {
      const boom: VpsCatalogAdapter = {
        provider: 'boom', requiresCredentials: false, provisionable: false,
        fetch: async () => { throw new Error('upstream 503'); },
      };
      const r = await svc([good('linode'), boom, good('vultr')]).search('u1', {});
      expect(r.offers.map((o) => o.provider).sort()).toEqual(['linode', 'vultr']);
      expect(r.sources.find((s) => s.provider === 'boom')).toMatchObject({
        status: 'error', offerCount: 0, message: 'upstream 503',
      });
    });

    it('survives an adapter whose result shape is wrong, and does not poison the cache', async () => {
      const malformed: VpsCatalogAdapter = {
        provider: 'malformed', requiresCredentials: false, provisionable: false,
        fetch: async () => JSON.parse(JSON.stringify([offer({ provider: 'malformed' })])) as AdapterResult,
      };
      const s = svc([good('linode'), malformed]);

      const first = await s.search('u1', {});
      expect(first.offers.map((o) => o.provider)).toEqual(['linode']);
      expect(first.sources.find((x) => x.provider === 'malformed')?.status).toBe('error');

      const second = await s.search('u1', {});
      expect(second.offers.map((o) => o.provider)).toEqual(['linode']);
      expect(second.sources.find((x) => x.provider === 'malformed')?.status).toBe('error');
    });
  });

  describe('the market a provider was read for', () => {
    let db: Database;
    beforeEach(async () => { db = await make(); });

    const au: VpsCatalogAdapter = {
      provider: 'ovh', requiresCredentials: false, provisionable: false,
      fetch: async () => ({
        offers: [offer({ provider: 'ovh', planId: 'vps-2027-model2', currency: 'AUD' })],
        skippedNoPrice: 0,
        market: { subsidiary: 'AU', currency: 'AUD', taxRate: 10 },
      }),
    };

    it('is carried on the source, fresh and from the cache', async () => {
      const s = new VpsCatalogService(db, KEY, [au]);
      const fresh = await s.search('u1', {});
      expect(fresh.sources[0]).toMatchObject({ provider: 'ovh', cached: false, market: { subsidiary: 'AU', currency: 'AUD', taxRate: 10 } });
      const cached = await s.search('u1', {});
      expect(cached.sources[0]).toMatchObject({ cached: true, market: { subsidiary: 'AU', currency: 'AUD' } });
    });

    it('is left out for a provider that names none', async () => {
      const plain: VpsCatalogAdapter = {
        provider: 'vultr', requiresCredentials: false, provisionable: false,
        fetch: async () => ({ offers: [offer({ provider: 'vultr' })], skippedNoPrice: 0 }),
      };
      const r = await new VpsCatalogService(db, KEY, [plain]).search('u1', {});
      expect(r.sources[0]).not.toHaveProperty('market');
    });
  });

  describe('a provider that needs the person\'s own token', () => {
    let db: Database;
    const savedToken = process.env.HCLOUD_TOKEN;
    beforeEach(async () => {
      db = await make();
      delete process.env.HCLOUD_TOKEN;
      for (const id of ['u1', 'u2']) await db.accounts.saveUser({ id, email: `${id}@example.com`, twoFactorEnabled: false, emailVerified: true, createdAt: 'x' });
    });
    afterEach(() => {
      if (savedToken === undefined) delete process.env.HCLOUD_TOKEN;
      else process.env.HCLOUD_TOKEN = savedToken;
    });

    const storeToken = async (id: string, token: string) => {
      const user = (await db.accounts.getUserById(id))!;
      await db.accounts.saveUser({ ...user, credentials: { hetzner: { token } } });
    };

    const gated = () => {
      const asked: Array<string | undefined> = [];
      const adapter: VpsCatalogAdapter = {
        provider: 'hetzner', requiresCredentials: true, provisionable: true,
        fetch: async (token) => { asked.push(token); return { offers: [offer({ provider: 'hetzner', planId: `cx-${token}` })], skippedNoPrice: 0 }; },
      };
      return { adapter, asked };
    };

    it('says to add a token, and asks the provider nothing, while the person has stored none', async () => {
      const { adapter, asked } = gated();
      const r = await new VpsCatalogService(db, KEY, [adapter]).search('u1', {});
      expect(r.offers).toEqual([]);
      expect(r.sources[0]).toMatchObject({ provider: 'hetzner', status: 'no-credentials', requiresCredentials: true });
      expect(asked).toEqual([]);
    });

    it('asks the provider with the token the person stored, and keeps each person\'s answer apart', async () => {
      await storeToken('u1', encryptValue('token-one', KEY));
      await storeToken('u2', encryptValue('token-two', KEY));
      const { adapter, asked } = gated();
      const svc = new VpsCatalogService(db, KEY, [adapter]);
      expect((await svc.search('u1', {})).offers.map((o) => o.planId)).toEqual(['cx-token-one']);
      expect((await svc.search('u2', {})).offers.map((o) => o.planId)).toEqual(['cx-token-two']);
      expect((await svc.search('u1', {})).sources[0]).toMatchObject({ status: 'ok', cached: true });
      expect(asked).toEqual(['token-one', 'token-two']);
    });

    it('counts a stored token that cannot be decrypted as none', async () => {
      await storeToken('u1', encryptValue('token-one', 'another-key'));
      const { adapter, asked } = gated();
      const r = await new VpsCatalogService(db, KEY, [adapter]).search('u1', {});
      expect(r.sources[0]).toMatchObject({ status: 'no-credentials' });
      expect(asked).toEqual([]);
    });

    it('refreshes after the cache is cleared', async () => {
      await storeToken('u1', encryptValue('token-one', KEY));
      const { adapter, asked } = gated();
      const svc = new VpsCatalogService(db, KEY, [adapter]);
      await svc.search('u1', {});
      svc.clearCache();
      await svc.search('u1', {});
      expect(asked).toEqual(['token-one', 'token-one']);
    });
  });
}
