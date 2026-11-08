import type { RequestHandler, Router } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { VpsCatalogFilters, VpsCatalogResult } from '../lib/vps-catalog/types.js';
import type { VpsCatalogService } from '../services/VpsCatalogService.js';
import { vpsCatalogRouter } from './vps-catalog.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/vps-catalog', router: () => router, user: PERSON });

const open: RequestHandler = (_req, _res, next) => next();
const closed: RequestHandler = (_req, res) => { res.status(403).json({ error: 'only the operator' }); };
const result = { offers: [], sources: [], fetchedAt: 'now' } as VpsCatalogResult;

describe('/api/vps-catalog', () => {
  it('searches with the filters read from the query', async () => {
    const vpsCatalogService = mock<VpsCatalogService>();
    vpsCatalogService.search.calledWith(matches<VpsCatalogFilters>((filters) => filters.minRamGb === 8 && filters.arch === 'arm')).mockResolvedValue(result);
    const answer = await (await on(vpsCatalogRouter({ vpsCatalogService, operatorOnly: open }))).get('/api/vps-catalog?minRamGb=8&arch=arm');
    expect(answer.data).toEqual(result);
  });

  it('refuses a filter that is not one with the reason', async () => {
    const answer = await (await on(vpsCatalogRouter({ vpsCatalogService: mock<VpsCatalogService>(), operatorOnly: open }))).get('/api/vps-catalog?arch=mips');
    expect(answer.status).toBe(400);
    expect(answer.data).toEqual({ error: 'arch must be one of x86, arm, unknown' });
  });

  it('answers 500 with the reason when a search fails', async () => {
    const vpsCatalogService = mock<VpsCatalogService>();
    vpsCatalogService.search.mockRejectedValue(new Error('all providers down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const answer = await (await on(vpsCatalogRouter({ vpsCatalogService, operatorOnly: open }))).get('/api/vps-catalog');
    log.mockRestore();
    expect(answer.status).toBe(500);
    expect(answer.data).toEqual({ error: 'all providers down' });
  });

  it('clears the cache on refresh only for whoever the operator gate lets through', async () => {
    const vpsCatalogService = mock<VpsCatalogService>();
    expect((await (await on(vpsCatalogRouter({ vpsCatalogService, operatorOnly: closed }))).post('/api/vps-catalog/refresh')).status).toBe(403);
    expect(vpsCatalogService.clearCache).not.toHaveBeenCalled();
    expect((await (await on(vpsCatalogRouter({ vpsCatalogService, operatorOnly: open }))).post('/api/vps-catalog/refresh')).data).toEqual({ ok: true });
    expect(vpsCatalogService.clearCache).toHaveBeenCalledOnce();
  });
});
