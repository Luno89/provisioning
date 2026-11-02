import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { TreeTypeSpec } from '../../projects/lib/tree-types.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { equalTo } from '../../platform/testing/matchers.js';
import type { ReleaseSettings } from '../services/ReleaseSettings.js';
import { releaseSettingsRouter } from './release-settings.js';

type Settings = Pick<ReleaseSettings, 'options' | 'setForType' | 'ofProject' | 'setForProject'>;

async function setUp() {
  const settings = mock<Settings>();
  const routes = await routesInProcess({ prefix: '/', router: () => releaseSettingsRouter({ settings }) });
  return { settings, routes };
}

describe('how a project\'s builds are released', () => {
  it('lists the agents that release and the apps they can release beside', async () => {
    const { settings, routes } = await setUp();
    const options = { agents: [{ slug: 'release', name: 'Release', needsApp: true }], apps: [] };
    settings.options.calledWith(TEST_USER.id).mockResolvedValue(options);
    expect((await routes.get('/options')).data).toEqual(options);
  });

  it('sets how a tree type releases, and clears it when none is sent', async () => {
    const { settings, routes } = await setUp();
    const how = { agent: 'release', app: 'odoo' };
    const type = { id: 'odoo', release: how } as TreeTypeSpec;
    settings.setForType.calledWith(TEST_USER.id, 'odoo', equalTo(how)).mockResolvedValue({ ok: true, value: type });
    settings.setForType.calledWith(TEST_USER.id, 'odoo', undefined).mockResolvedValue({ ok: true, value: { id: 'odoo' } as TreeTypeSpec });
    expect((await routes.put('/tree-types/odoo', { release: how })).data).toEqual(type);
    expect((await routes.put('/tree-types/odoo', {})).data).toEqual({ id: 'odoo' });
  });

  it('says why a tree type\'s setting was refused', async () => {
    const { settings, routes } = await setUp();
    settings.setForType.mockResolvedValue({ ok: false, status: 404, error: 'there is no tree type nope' });
    const refused = await routes.put('/tree-types/nope', { release: { agent: 'x' } });
    expect([refused.status, refused.data]).toEqual([404, { error: 'there is no tree type nope' }]);
  });

  it('reads and sets how one project releases, saying why when it cannot', async () => {
    const { settings, routes } = await setUp();
    const how = { agent: 'release-replace' };
    settings.ofProject.calledWith(TEST_USER.id, 'p1').mockResolvedValue({ ok: true, value: { how, from: 'project' } });
    settings.ofProject.calledWith(TEST_USER.id, 'p2').mockResolvedValue({ ok: false, status: 404, error: 'Project not found' });
    settings.setForProject.calledWith(TEST_USER.id, 'p1', equalTo(how)).mockResolvedValue({ ok: true, value: { how, from: 'project' } });
    settings.setForProject.calledWith(TEST_USER.id, 'p1', equalTo({ agent: 'bad' })).mockResolvedValue({ ok: false, status: 400, error: 'bad is not an agent that releases builds' });
    expect((await routes.get('/projects/p1')).data).toEqual({ how, from: 'project' });
    expect((await routes.get('/projects/p2')).status).toBe(404);
    expect((await routes.put('/projects/p1', { release: how })).data).toEqual({ how, from: 'project' });
    const refused = await routes.put('/projects/p1', { release: { agent: 'bad' } });
    expect([refused.status, refused.data]).toEqual([400, { error: 'bad is not an agent that releases builds' }]);
  });
});
