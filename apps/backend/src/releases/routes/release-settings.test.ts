import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { TreeTypeSpec } from '../../projects/lib/tree-types.js';
import { dispatch, SIGNED_IN } from '../testing/dispatch.js';
import { equalTo } from '../testing/equal-to.js';
import type { ReleaseSettings } from '../services/ReleaseSettings.js';
import { releaseSettingsRouter } from './release-settings.js';

type Settings = Pick<ReleaseSettings, 'options' | 'setForType' | 'ofProject' | 'setForProject'>;

function setUp() {
  const settings = mock<Settings>();
  return { settings, router: releaseSettingsRouter({ settings }) };
}

describe('how a project\'s builds are released', () => {
  it('lists the agents that release and the apps they can release beside', async () => {
    const { settings, router } = setUp();
    const options = { agents: [{ slug: 'release', name: 'Release', needsApp: true }], apps: [] };
    settings.options.calledWith(SIGNED_IN.id).mockResolvedValue(options);
    expect((await dispatch(router, { method: 'GET', url: '/options' })).json).toEqual(options);
  });

  it('sets how a tree type releases, and clears it when none is sent', async () => {
    const { settings, router } = setUp();
    const how = { agent: 'release', app: 'odoo' };
    const type = { id: 'odoo', release: how } as TreeTypeSpec;
    settings.setForType.calledWith(SIGNED_IN.id, 'odoo', equalTo(how)).mockResolvedValue({ ok: true, value: type });
    settings.setForType.calledWith(SIGNED_IN.id, 'odoo', undefined).mockResolvedValue({ ok: true, value: { id: 'odoo' } as TreeTypeSpec });
    expect((await dispatch(router, { method: 'PUT', url: '/tree-types/odoo', json: { release: how } })).json).toEqual(type);
    expect((await dispatch(router, { method: 'PUT', url: '/tree-types/odoo', json: {} })).json).toEqual({ id: 'odoo' });
  });

  it('says why a tree type\'s setting was refused', async () => {
    const { settings, router } = setUp();
    settings.setForType.mockResolvedValue({ ok: false, status: 404, error: 'there is no tree type nope' });
    const refused = await dispatch(router, { method: 'PUT', url: '/tree-types/nope', json: { release: { agent: 'x' } } });
    expect([refused.status, refused.json]).toEqual([404, { error: 'there is no tree type nope' }]);
  });

  it('reads and sets how one project releases, saying why when it cannot', async () => {
    const { settings, router } = setUp();
    const how = { agent: 'release-replace' };
    settings.ofProject.calledWith(SIGNED_IN.id, 'p1').mockResolvedValue({ ok: true, value: { how, from: 'project' } });
    settings.ofProject.calledWith(SIGNED_IN.id, 'p2').mockResolvedValue({ ok: false, status: 404, error: 'Project not found' });
    settings.setForProject.calledWith(SIGNED_IN.id, 'p1', equalTo(how)).mockResolvedValue({ ok: true, value: { how, from: 'project' } });
    settings.setForProject.calledWith(SIGNED_IN.id, 'p1', equalTo({ agent: 'bad' })).mockResolvedValue({ ok: false, status: 400, error: 'bad is not an agent that releases builds' });
    expect((await dispatch(router, { method: 'GET', url: '/projects/p1' })).json).toEqual({ how, from: 'project' });
    expect((await dispatch(router, { method: 'GET', url: '/projects/p2' })).status).toBe(404);
    expect((await dispatch(router, { method: 'PUT', url: '/projects/p1', json: { release: how } })).json).toEqual({ how, from: 'project' });
    const refused = await dispatch(router, { method: 'PUT', url: '/projects/p1', json: { release: { agent: 'bad' } } });
    expect([refused.status, refused.json]).toEqual([400, { error: 'bad is not an agent that releases builds' }]);
  });
});
