import { containing, matching } from '../../../platform/lib/test-matchers.js';
import { describe, expect, it } from 'vitest';
import { DNS_PROVIDERS } from '../../lib/dns-providers.js';
import { DNS_PROVIDER_CLIENTS, DnsProviders } from './DnsProviders.js';
import { fakeCloudflare, fakePorkbun } from './fake-dns.js';

describe('the DNS provider registry service', () => {
  it('has a client for every provider described, and describes them without their env names', () => {
    expect(DNS_PROVIDER_CLIENTS.map((make) => make(fetch).name).sort()).toEqual(DNS_PROVIDERS.map((provider) => provider.name).sort());
    expect(new DnsProviders().describe().map((provider) => provider.name)).toEqual(['cloudflare', 'porkbun']);
  });

  it('finds a zone\'s provider from its nameservers, and says why when it cannot', async () => {
    const dns = new DnsProviders(fetch, async (zone) => {
      if (zone === 'gone.test') throw Object.assign(new Error('queryNs ENOTFOUND gone.test'), { code: 'ENOTFOUND' });
      return zone === 'koala.test' ? ['fortaleza.ns.porkbun.com'] : ['ns1.example.net'];
    });
    expect(await dns.detect('koala.test')).toEqual({ zone: 'koala.test', nameservers: ['fortaleza.ns.porkbun.com'], provider: 'porkbun' });
    expect(await dns.detect('gone.test')).toMatchObject({ nameservers: [], problem: containing('ENOTFOUND') });
    expect(await dns.detect('other.test')).toMatchObject({ problem: containing('ns1.example.net') });
  });

  it('refuses a provider it does not know, and runs a plan, logging what it left alone', async () => {
    const fake = fakePorkbun(['koala.test']);
    const dns = new DnsProviders(fake.fetch, async () => []);
    expect(() => dns.provider('route53')).toThrow(/knows cloudflare, porkbun/);
    const zone = await dns.zone('porkbun', fake.good, 'koala.test');
    await zone.create({ type: 'A', name: 'mesh.koala.test', content: '198.51.100.1' });
    const { done, lines } = await dns.apply(zone, await dns.plan(zone, [{ type: 'A', name: 'mesh.koala.test', content: '203.0.113.7', why: 'root', onConflict: 'refuse' }]));
    expect(done).toBe(false);
    expect(lines).toEqual([matching(/^left as it is: .*198\.51\.100\.1/)]);
  });

  it('validates credentials with the provider named, and refuses a provider it does not know', async () => {
    const fake = fakePorkbun(['koala.test']);
    const dns = new DnsProviders(fake.fetch, async () => []);
    expect(await dns.validate('porkbun', fake.good)).toMatchObject({ valid: true });
    expect(await dns.validate('porkbun', fake.bad)).toMatchObject({ valid: false, message: containing('Invalid API key') });
    expect(() => dns.validate('route53', fake.good)).toThrow(/knows cloudflare, porkbun/);
  });
});


describe('carrying out a zone\'s plan through each provider\'s own client', () => {
  for (const [provider, fake] of [['cloudflare', fakeCloudflare(['koala.test'])], ['porkbun', fakePorkbun(['koala.test'])]] as const) {
    it(`adds what is missing and moves a record to its new address on ${provider}`, async () => {
      const dns = new DnsProviders(fake.fetch, async () => []);
      const zone = await dns.zone(provider, fake.good, 'koala.test');
      await zone.create({ type: 'A', name: 'mesh.koala.test', content: '198.51.100.1' });
      const steps = await dns.plan(zone, [
        { type: 'A', name: 'mesh.koala.test', content: '203.0.113.7', why: 'the mesh moved', onConflict: 'replace' },
        { type: 'A', name: 'app.koala.test', content: '203.0.113.7', why: 'root answers here', onConflict: 'refuse' },
      ]);
      expect(await dns.apply(zone, steps)).toEqual({ done: true, lines: ['updated A mesh.koala.test: the mesh moved', 'added A app.koala.test: root answers here'] });
      expect((await zone.all()).map((record) => `${record.name} ${record.content}`).sort()).toEqual(['app.koala.test 203.0.113.7', 'mesh.koala.test 203.0.113.7']);
    });
  }
});
