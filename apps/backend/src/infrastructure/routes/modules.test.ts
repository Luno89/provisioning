import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { GitModuleService } from '../services/GitModuleService.js';
import { modulesRouter } from './modules.js';
import { callRouter } from '../testing/call-router.js';

describe('/api/modules', () => {
  it('lists the modules available for the app type asked', async () => {
    const gitModuleService = mock<GitModuleService>();
    gitModuleService.listAvailableModules.calledWith('odoo').mockResolvedValue([{ name: 'sale_extra' }] as never);
    const answer = await callRouter(modulesRouter({ gitModuleService }), '/api/modules', { path: '?appType=odoo' });
    expect(answer.body).toEqual([{ name: 'sale_extra' }]);
  });
});
