import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import type { RequestHandler } from 'express';
import { http, HttpResponse, passthrough } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { anyOf, objectWith } from '../../platform/lib/test-matchers.js';
import { vultrAdapter } from '../lib/vps-catalog/adapters.js';
import { VpsCatalogService } from '../services/VpsCatalogService.js';
import { vpsCatalogRouter } from './vps-catalog.js';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const vultrPlan = (id: string, vendor: string, ramMb: number, monthly: number) => ({
  id, type: 'vc2', vcpu_count: 2, cpu_vendor: vendor, ram: ramMb, disk: 80, disk_count: 1, bandwidth: 2000,
  monthly_cost: monthly, hourly_cost: monthly / 730, locations: ['ewr'],
});

const asked: string[] = [];
interceptHttp(
  http.all(/^http:\/\/localhost:\d+\//, () => passthrough()),
  http.get('https://api.vultr.com/v2/plans', ({ request }) => {
    asked.push(request.url);
    return HttpResponse.json({ plans: [vultrPlan('vultr-arm-8', 'Ampere', 8192, 24), vultrPlan('vultr-arm-4', 'Ampere', 4096, 12), vultrPlan('vultr-x86-16', 'AMD', 16384, 48)] });
  }),
);

const open: RequestHandler = (_req, _res, next) => next();
const quiet = { validateStatus: () => true };

describe('/api/vps-catalog over HTTP', () => {
  it('searches with the filters read from the query, asking each provider\'s public price list with no keys', async () => {
    harness = await mountRouter({ prefix: '/api/vps-catalog', router: () => vpsCatalogRouter({ vpsCatalogService: new VpsCatalogService([vultrAdapter]), operatorOnly: open }) });
    const answer = (await axios.get(harness.url('/api/vps-catalog?minRamGb=8&arch=arm'))).data as { offers: { provider: string; planId: string }[] };
    expect(answer).toEqual({
      offers: [
        objectWith({ provider: 'vultr', planId: 'vultr-arm-8', arch: 'arm', ramGb: 8 }),
      ],
      sources: [
        { provider: 'vultr', status: 'ok', offerCount: 3, cached: false },
      ],
      fetchedAt: anyOf(String),
    });
    expect(asked).toEqual(['https://api.vultr.com/v2/plans?per_page=500']);
    const refused = await axios.get(harness.url('/api/vps-catalog?arch=mips'), quiet);
    expect([refused.status, refused.data]).toEqual([400, { error: 'arch must be one of x86, arm, unknown' }]);
    expect(asked).toHaveLength(1);
  });
});
