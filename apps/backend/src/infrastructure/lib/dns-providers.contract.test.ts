import { describe, expect, it } from 'vitest';
import { DNS_PROVIDER_CLIENTS, DnsProviders } from '../services/dns/DnsProviders.js';
import { FAKE_DNS } from '../services/dns/fake-dns.js';
import { DNS_PROVIDERS, DnsProviderRefusal, type DnsProvider } from './dns-providers.js';

const ZONE = 'koala.test';
const HIDDEN = 'hidden.test';

const providerFor = (name: string, fetchImpl: Parameters<(typeof DNS_PROVIDER_CLIENTS)[number]>[0]): DnsProvider =>
  DNS_PROVIDER_CLIENTS.map((make) => make(fetchImpl)).find((provider) => provider.name === name)!;

describe('every registered DNS provider has a fake to be held to the contract against', () => {
  it('names a fake for each provider the registry describes', () => {
    expect(Object.keys(FAKE_DNS).sort()).toEqual(DNS_PROVIDERS.map((provider) => provider.name).sort());
  });
});

for (const described of DNS_PROVIDERS) {
  describe(`the DNS provider contract: ${described.label}`, () => {
    const setUp = () => {
      const fake = FAKE_DNS[described.name]!([ZONE, HIDDEN], [ZONE]);
      return { fake, provider: providerFor(described.name, fake.fetch) };
    };

    it('accepts its own credentials and refuses others, in a plain sentence', async () => {
      const { fake, provider } = setUp();
      expect((await provider.validate(fake.good)).valid).toBe(true);
      const refused = await provider.validate(fake.bad);
      expect(refused.valid).toBe(false);
      expect(refused.message).toMatch(/\w/);
    });

    it('refuses a zone it cannot reach, saying what to do', async () => {
      const { fake, provider } = setUp();
      await expect(provider.zone(fake.good, HIDDEN)).rejects.toBeInstanceOf(DnsProviderRefusal);
      await expect(provider.zone(fake.bad, ZONE)).rejects.toBeInstanceOf(DnsProviderRefusal);
    });

    it('creates records at a name, the apex and the wildcard, and lists them by type and full name', async () => {
      const { fake, provider } = setUp();
      const zone = await provider.zone(fake.good, ZONE);
      await zone.create({ type: 'A', name: `app.${ZONE}`, content: '203.0.113.7' });
      await zone.create({ type: 'A', name: `*.${ZONE}`, content: '203.0.113.7' });
      await zone.create({ type: 'TXT', name: ZONE, content: 'v=spf1 ip4:203.0.113.7 ~all' });
      expect((await zone.list('A', `app.${ZONE}`)).map((record) => [record.name, record.content])).toEqual([[`app.${ZONE}`, '203.0.113.7']]);
      expect((await zone.list('A', `*.${ZONE}`)).map((record) => record.name)).toEqual([`*.${ZONE}`]);
      expect((await zone.list('TXT', ZONE)).map((record) => record.content)).toEqual(['v=spf1 ip4:203.0.113.7 ~all']);
      expect((await zone.list('A', `mesh.${ZONE}`))).toEqual([]);
      expect((await zone.all()).length).toBe(3);
      for (const record of await zone.all()) expect(record.id).toBeTruthy();
    });

    it('updates and removes one record by its id, leaving another of the same name and type alone', async () => {
      const { fake, provider } = setUp();
      const zone = await provider.zone(fake.good, ZONE);
      await zone.create({ type: 'TXT', name: ZONE, content: 'v=spf1 include:_spf.example.com ~all' });
      await zone.create({ type: 'TXT', name: ZONE, content: 'google-site-verification=abc' });
      const [first, second] = await zone.list('TXT', ZONE);
      await zone.update({ ...first!, id: first!.id!, content: 'v=spf1 ip4:203.0.113.7 ~all' });
      expect((await zone.list('TXT', ZONE)).map((record) => record.content).sort()).toEqual(['google-site-verification=abc', 'v=spf1 ip4:203.0.113.7 ~all']);
      await zone.remove({ ...second!, id: second!.id! });
      expect((await zone.list('TXT', ZONE)).map((record) => record.content)).toEqual(['v=spf1 ip4:203.0.113.7 ~all']);
    });

    it('through the registry, a plan never rewrites a record it did not make', async () => {
      const fake = FAKE_DNS[described.name]!([ZONE]);
      const dns = new DnsProviders(fake.fetch, async () => []);
      const zone = await dns.zone(described.name, fake.good, ZONE);
      await zone.create({ type: 'A', name: `mesh.${ZONE}`, content: '198.51.100.1' });
      const wanted = (name: string) => ({ type: 'A' as const, name, content: '203.0.113.7', why: 'root', onConflict: 'refuse' as const });
      const steps = await dns.plan(zone, [wanted(`app.${ZONE}`), wanted(`mesh.${ZONE}`)]);
      expect(steps.map((step) => step.do)).toEqual(['create', 'refuse']);
      const { done } = await dns.apply(zone, steps);
      expect(done).toBe(false);
      expect((await zone.list('A', `mesh.${ZONE}`)).map((record) => record.content)).toEqual(['198.51.100.1']);
      expect((await zone.list('A', `app.${ZONE}`)).map((record) => record.content)).toEqual(['203.0.113.7']);
    });
  });
}
