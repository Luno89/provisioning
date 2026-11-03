import { describe, expect, it } from 'vitest';
import { DnsProviders } from './DnsProviders.js';
import { fakeCloudflare, fakePorkbun } from './fake-dns.js';

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
