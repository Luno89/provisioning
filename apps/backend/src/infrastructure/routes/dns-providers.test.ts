import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { DnsProviders } from '../services/dns/DnsProviders.js';
import { dnsProvidersRouter } from './dns-providers.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/dns-providers', router: () => router, user: PERSON });

describe('/api/dns-providers', () => {
  it('lists every DNS provider Koala can use with the fields its credentials take', async () => {
    const dns = new DnsProviders(async () => new Response('{}'), async () => []);
    const answer = await (await on(dnsProvidersRouter({ dns }))).get('/api/dns-providers');
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual(JSON.parse(JSON.stringify(dns.describe())));
    expect((answer.data as { name: string }[]).map((provider) => provider.name)).toEqual(expect.arrayContaining(['cloudflare', 'porkbun']));
  });
});
