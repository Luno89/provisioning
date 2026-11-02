import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { GitModuleService } from '../services/GitModuleService.js';
import { modulesRouter } from './modules.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/modules', router: () => router, user: PERSON });

describe('/api/modules', () => {
  it('lists the modules available for the app type asked', async () => {
    const gitModuleService = mock<GitModuleService>();
    gitModuleService.listAvailableModules.calledWith('odoo').mockResolvedValue([{ name: 'sale_extra' }] as never);
    const answer = await (await on(modulesRouter({ gitModuleService }))).get('/api/modules?appType=odoo');
    expect(answer.data).toEqual([{ name: 'sale_extra' }]);
  });
});
