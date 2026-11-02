import { describe, expect, it } from 'vitest';
import { DnsProviders } from '../services/dns/DnsProviders.js';
import { dnsProvidersRouter } from './dns-providers.js';
import { callRouter } from '../testing/call-router.js';

describe('/api/dns-providers', () => {
  it('lists every DNS provider Koala can use with the fields its credentials take', async () => {
    const dns = new DnsProviders(async () => new Response('{}'), async () => []);
    const answer = await callRouter(dnsProvidersRouter({ dns }), '/api/dns-providers', {});
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(JSON.parse(JSON.stringify(dns.describe())));
    expect((answer.body as { name: string }[]).map((provider) => provider.name)).toEqual(expect.arrayContaining(['cloudflare', 'porkbun']));
  });
});
