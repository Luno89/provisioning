import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import type { RequestHandler } from 'express';
import { matches, mock } from 'vitest-mock-extended';
import type { VpsCatalogFilters, VpsCatalogResult } from '../lib/vps-catalog/types.js';
import type { VpsCatalogService } from '../services/VpsCatalogService.js';
import { vpsCatalogRouter } from './vps-catalog.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const open: RequestHandler = (_req, _res, next) => next();
const result = { offers: [], sources: [], fetchedAt: 'now' } as VpsCatalogResult;
const quiet = { validateStatus: () => true };

describe('/api/vps-catalog over HTTP', () => {
  it('searches with the filters read from the query, as the person signed in', async () => {
    const vpsCatalogService = mock<VpsCatalogService>();
    vpsCatalogService.search.calledWith(TEST_USER.id, matches<VpsCatalogFilters>((filters) => filters.minRamGb === 8 && filters.arch === 'arm')).mockResolvedValue(result);
    harness = await mountRouter({ prefix: '/api/vps-catalog', router: () => vpsCatalogRouter({ vpsCatalogService, operatorOnly: open }) });
    expect((await axios.get(harness.url('/api/vps-catalog?minRamGb=8&arch=arm'))).data).toEqual(result);
    const refused = await axios.get(harness.url('/api/vps-catalog?arch=mips'), quiet);
    expect([refused.status, refused.data]).toEqual([400, { error: 'arch must be one of x86, arm, unknown' }]);
  });
});
