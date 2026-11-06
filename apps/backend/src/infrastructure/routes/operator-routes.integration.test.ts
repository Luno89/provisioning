import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { http, HttpResponse, passthrough } from 'msw';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { createAuth } from '../../platform/middleware/auth.js';
import { SessionEnds } from '../../platform/services/SessionEnds.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { vultrAdapter } from '../lib/vps-catalog/adapters.js';
import { VpsCatalogService } from '../services/VpsCatalogService.js';
import WorkerService from '../services/WorkerService.js';
import { vpsCatalogRouter } from './vps-catalog.js';
import { workerRouter } from './worker.js';

const operatorOnly = (db: Database) => createAuth({ db, sessionKey: 'operator-routes-key', publicUrl: 'http://localhost:3001', sessionEnds: new SessionEnds(db.platform) }).requireOperator('administer');

let vultrFetches = 0;
interceptHttp(
  http.all(/^http:\/\/localhost:\d+\//, () => passthrough()),
  http.get('https://api.vultr.com/v2/plans', () => {
    vultrFetches += 1;
    return HttpResponse.json({ plans: [{ id: 'vc2-1c-1gb', type: 'vc2', vcpu_count: 1, cpu_vendor: 'AMD', ram: 1024, disk: 25, monthly_cost: 5, locations: ['ewr'] }] });
  }),
);

let harness: Harness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

describe('what only the operator of this server does', () => {
  it('clears the price cache every person\'s catalogue reads', async () => {
    harness = await mountRouter({ prefix: '/api/vps-catalog', router: (db) => vpsCatalogRouter({ vpsCatalogService: new VpsCatalogService(db, 'test-key', [vultrAdapter]), operatorOnly: operatorOnly(db) }) });
    const cachedNow = async () => ((await axios.get(harness!.url('/api/vps-catalog'))).data as { sources: { cached: boolean }[] }).sources[0]?.cached;
    expect(await cachedNow()).toBe(false);
    expect((await axios.post(harness.url('/api/vps-catalog/refresh'), {}, { validateStatus: () => true })).status).toBe(403);
    expect(await cachedNow()).toBe(true);
    expect(vultrFetches).toBe(1);
    harness.setUser({ ...TEST_USER, roles: ['operator' as const] });
    expect((await axios.post(harness.url('/api/vps-catalog/refresh'))).data).toEqual({ ok: true });
    expect(await cachedNow()).toBe(false);
    expect(vultrFetches).toBe(2);
  });

  it('starts and stops the worker, which anyone may still read', async () => {
    const workerService = new WorkerService();
    await workerService.start('c');
    harness = await mountRouter({ prefix: '/api/worker', router: (db) => workerRouter({ workerService, operatorOnly: operatorOnly(db) }) });
    expect((await axios.post(harness.url('/api/worker'), { clusterId: 'c' }, { validateStatus: () => true })).status).toBe(403);
    expect((await axios.delete(harness.url('/api/worker'), { validateStatus: () => true })).status).toBe(403);
    expect((await axios.get(harness.url('/api/worker'))).data).toMatchObject({ running: true });
    harness.setUser({ ...TEST_USER, roles: ['operator' as const] });
    expect((await axios.post(harness.url('/api/worker'), { clusterId: 'c' })).status).toBe(202);
  });
});
