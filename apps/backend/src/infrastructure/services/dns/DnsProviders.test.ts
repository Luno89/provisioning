import { describe, expect, it } from 'vitest';
import { DNS_PROVIDERS } from '../../lib/dns-providers.js';
import { DNS_PROVIDER_CLIENTS, DnsProviders } from './DnsProviders.js';
import { fakePorkbun } from './fake-dns.js';
import { containing, matching } from '../test-matchers.js';

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
});
