import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import type { RequestHandler } from 'express';
import { http, HttpResponse, passthrough } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { anyOf, objectWith } from '../../platform/lib/test-matchers.js';
import { encryptValue } from '../../platform/lib/crypto.js';
import { hetznerAdapter, vultrAdapter } from '../lib/vps-catalog/adapters.js';
import { VpsCatalogService } from '../services/VpsCatalogService.js';
import { vpsCatalogRouter } from './vps-catalog.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const KEY = 'test-key';

const vultrPlan = (id: string, vendor: string, ramMb: number, monthly: number) => ({
  id, type: 'vc2', vcpu_count: 2, cpu_vendor: vendor, ram: ramMb, disk: 80, disk_count: 1, bandwidth: 2000,
  monthly_cost: monthly, hourly_cost: monthly / 730, locations: ['ewr'],
});

const hetznerType = (name: string, architecture: string, memory: number, monthly: string) => ({
  name, description: name, cores: 4, cpu_type: 'shared', architecture, memory, disk: 80, deprecated: false,
  prices: [{ location: 'fsn1', price_monthly: { net: monthly }, price_hourly: { net: '0.01' }, included_traffic: 21990232555520 }],
});

const asked: string[] = [];
interceptHttp(
  http.all(/^http:\/\/localhost:\d+\//, () => passthrough()),
  http.get('https://api.vultr.com/v2/plans', ({ request }) => {
    asked.push(request.url);
    return HttpResponse.json({ plans: [vultrPlan('vultr-arm-8', 'Ampere', 8192, 24), vultrPlan('vultr-arm-4', 'Ampere', 4096, 12), vultrPlan('vultr-x86-16', 'AMD', 16384, 48)] });
  }),
  http.get('https://api.hetzner.cloud/v1/server_types', ({ request }) => {
    asked.push(`${request.url} ${request.headers.get('authorization') ?? ''}`);
    return HttpResponse.json({ server_types: [hetznerType('cax21', 'arm', 8, '7.49'), hetznerType('cx22', 'x86', 8, '4.59')] });
  }),
);

const open: RequestHandler = (_req, _res, next) => next();
const quiet = { validateStatus: () => true };

describe('/api/vps-catalog over HTTP', () => {
  it('searches with the filters read from the query, as the person signed in', async () => {
    harness = await mountRouter({ prefix: '/api/vps-catalog', router: (db) => vpsCatalogRouter({ vpsCatalogService: new VpsCatalogService(db, KEY, [hetznerAdapter, vultrAdapter]), operatorOnly: open }) });
    await harness.db.accounts.saveUser({ ...TEST_USER, twoFactorEnabled: false, emailVerified: true, createdAt: 'x', credentials: { hetzner: { token: encryptValue('hcloud-of-the-person', KEY) } } } as never);
    const answer = (await axios.get(harness.url('/api/vps-catalog?minRamGb=8&arch=arm'))).data as { offers: { provider: string; planId: string }[] };
    expect(answer).toEqual({
      offers: [
        objectWith({ provider: 'hetzner', planId: 'cax21', arch: 'arm', ramGb: 8 }),
        objectWith({ provider: 'vultr', planId: 'vultr-arm-8', arch: 'arm', ramGb: 8 }),
      ],
      sources: [
        { provider: 'hetzner', status: 'ok', offerCount: 2, requiresCredentials: true, cached: false },
        { provider: 'vultr', status: 'ok', offerCount: 3, requiresCredentials: false, cached: false },
      ],
      fetchedAt: anyOf(String),
    });
    expect(asked.sort()).toEqual(['https://api.hetzner.cloud/v1/server_types?per_page=100 Bearer hcloud-of-the-person', 'https://api.vultr.com/v2/plans?per_page=500']);
    const refused = await axios.get(harness.url('/api/vps-catalog?arch=mips'), quiet);
    expect([refused.status, refused.data]).toEqual([400, { error: 'arch must be one of x86, arm, unknown' }]);
    expect(asked).toHaveLength(2);
  });
});
