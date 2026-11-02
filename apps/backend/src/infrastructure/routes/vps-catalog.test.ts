import type { RequestHandler } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { VpsCatalogFilters, VpsCatalogResult } from '../lib/vps-catalog/types.js';
import type { VpsCatalogService } from '../services/VpsCatalogService.js';
import { vpsCatalogRouter } from './vps-catalog.js';
import { callRouter, PERSON } from '../testing/call-router.js';

const open: RequestHandler = (_req, _res, next) => next();
const closed: RequestHandler = (_req, res) => { res.status(403).json({ error: 'only the operator' }); };
const result = { offers: [], sources: [], fetchedAt: 'now' } as VpsCatalogResult;

describe('/api/vps-catalog', () => {
  it('searches with the filters read from the query, as the person asking', async () => {
    const vpsCatalogService = mock<VpsCatalogService>();
    vpsCatalogService.search.calledWith(PERSON.id, matches<VpsCatalogFilters>((filters) => filters.minRamGb === 8 && filters.arch === 'arm')).mockResolvedValue(result);
    const answer = await callRouter(vpsCatalogRouter({ vpsCatalogService, operatorOnly: open }), '/api/vps-catalog', { path: '?minRamGb=8&arch=arm' });
    expect(answer.body).toEqual(result);
  });

  it('refuses a filter that is not one with the reason', async () => {
    const answer = await callRouter(vpsCatalogRouter({ vpsCatalogService: mock<VpsCatalogService>(), operatorOnly: open }), '/api/vps-catalog', { path: '?arch=mips' });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: 'arch must be one of x86, arm, unknown' });
  });

  it('answers 500 with the reason when a search fails', async () => {
    const vpsCatalogService = mock<VpsCatalogService>();
    vpsCatalogService.search.mockRejectedValue(new Error('all providers down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const answer = await callRouter(vpsCatalogRouter({ vpsCatalogService, operatorOnly: open }), '/api/vps-catalog', {});
    log.mockRestore();
    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({ error: 'all providers down' });
  });

  it('clears the cache on refresh only for whoever the operator gate lets through', async () => {
    const vpsCatalogService = mock<VpsCatalogService>();
    expect((await callRouter(vpsCatalogRouter({ vpsCatalogService, operatorOnly: closed }), '/api/vps-catalog', { method: 'POST', path: '/refresh' })).status).toBe(403);
    expect(vpsCatalogService.clearCache).not.toHaveBeenCalled();
    expect((await callRouter(vpsCatalogRouter({ vpsCatalogService, operatorOnly: open }), '/api/vps-catalog', { method: 'POST', path: '/refresh' })).body).toEqual({ ok: true });
    expect(vpsCatalogService.clearCache).toHaveBeenCalledOnce();
  });
});
