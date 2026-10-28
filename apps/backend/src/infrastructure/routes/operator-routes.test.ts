import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import express from 'express';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { authorize, type Principal } from '../../platform/lib/permissions.js';
import { vpsCatalogRouter } from './vps-catalog.js';
import { workerRouter } from './worker.js';

const operatorOnly: express.RequestHandler = (req, res, next) => {
  const decision = authorize((req as unknown as { principal: Principal }).principal, 'administer', { kind: 'install' });
  if (!decision.allowed) return res.status(decision.status).json({ error: decision.error });
  next();
};

let harness: Harness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

describe('what only the operator of this server does', () => {
  it('clears the price cache every person\'s catalogue reads', async () => {
    const vpsCatalogService = { clearCache: vi.fn(), search: vi.fn() };
    harness = await mountRouter({ prefix: '/api/vps-catalog', router: () => vpsCatalogRouter({ vpsCatalogService, operatorOnly }) });
    expect((await axios.post(harness.url('/api/vps-catalog/refresh'), {}, { validateStatus: () => true })).status).toBe(403);
    expect(vpsCatalogService.clearCache).not.toHaveBeenCalled();
    harness.setUser({ ...TEST_USER, isAdmin: true });
    expect((await axios.post(harness.url('/api/vps-catalog/refresh'))).data).toEqual({ ok: true });
    expect(vpsCatalogService.clearCache).toHaveBeenCalledTimes(1);
  });

  it('starts and stops the worker, which anyone may still read', async () => {
    const workerService = { status: () => ({ clusterId: 'c', context: 'local', state: 'running' }) };
    harness = await mountRouter({ prefix: '/api/worker', router: () => workerRouter({ workerService, operatorOnly }) });
    expect((await axios.post(harness.url('/api/worker'), { clusterId: 'c' }, { validateStatus: () => true })).status).toBe(403);
    expect((await axios.delete(harness.url('/api/worker'), { validateStatus: () => true })).status).toBe(403);
    expect((await axios.get(harness.url('/api/worker'))).data).toMatchObject({ running: true });
    harness.setUser({ ...TEST_USER, isAdmin: true });
    expect((await axios.post(harness.url('/api/worker'), { clusterId: 'c' })).status).toBe(202);
  });
});
