import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { releaseSettingsOver, releaseSettingsWorld } from '../testing/release-settings-behaviour.js';
import { releaseSettingsRouter } from './release-settings.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const quiet = { validateStatus: () => true };

async function mount(): Promise<Harness> {
  h = await mountRouter({
    prefix: '/api/release-settings',
    router: async (db) => {
      await releaseSettingsWorld(db, TEST_USER.id);
      return releaseSettingsRouter({ settings: releaseSettingsOver(db) });
    },
  });
  return h;
}

describe('how a project\'s builds are released, over HTTP', () => {
  it('lists the agents that release and the apps they can release beside', async () => {
    const harness = await mount();
    expect((await axios.get(harness.url('/api/release-settings/options'))).data).toEqual({
      agents: [
        { slug: 'my', name: 'My release', description: 'mine', needsApp: true },
        { slug: 'release', name: 'Release', needsApp: true },
        { slug: 'release-replace', name: 'Release by replacing', needsApp: false },
      ],
      apps: [{ id: 'odoo', title: 'Odoo', restores: true }],
    });
  });

  it('sets how a tree type releases for the person, keeps it, and clears it when none is sent', async () => {
    const harness = await mount();
    const how = { agent: 'my', app: 'odoo' };
    const set = await axios.put(harness.url('/api/release-settings/tree-types/odoo-addons'), { release: how });
    expect(set.data).toMatchObject({ id: 'odoo-addons', ownerId: TEST_USER.id, release: how });
    expect((await harness.db.projects.getTreeTypes(TEST_USER.id)).find((type) => type.ownerId === TEST_USER.id)?.release).toEqual(how);
    const cleared = await axios.put(harness.url('/api/release-settings/tree-types/odoo-addons'), {});
    expect(cleared.data).not.toHaveProperty('release');
    expect((await harness.db.projects.getTreeTypes(TEST_USER.id)).find((type) => type.ownerId === TEST_USER.id)?.release).toBeUndefined();
  });

  it('says why a tree type\'s setting was refused', async () => {
    const harness = await mount();
    const missing = await axios.put(harness.url('/api/release-settings/tree-types/nope'), { release: { agent: 'release', app: 'odoo' } }, quiet);
    expect([missing.status, missing.data]).toEqual([404, { error: 'there is no tree type nope' }]);
    const bad = await axios.put(harness.url('/api/release-settings/tree-types/odoo-addons'), { release: { agent: 'koala' } }, quiet);
    expect([bad.status, bad.data]).toEqual([400, { error: 'koala is not an agent that releases builds' }]);
  });

  it('reads and sets how one project releases, saying why when it cannot', async () => {
    const harness = await mount();
    expect((await axios.get(harness.url('/api/release-settings/projects/p1'))).data).toEqual({ how: { agent: 'release', app: 'odoo' }, from: 'tree type' });
    const how = { agent: 'release-replace' };
    expect((await axios.put(harness.url('/api/release-settings/projects/p1'), { release: how })).data).toEqual({ how, from: 'project' });
    expect((await harness.db.projects.getProjects()).find((project) => project.id === 'p1')?.release).toEqual(how);
    expect((await axios.put(harness.url('/api/release-settings/projects/p1'), {})).data).toEqual({ how: { agent: 'release', app: 'odoo' }, from: 'tree type' });
    const missing = await axios.get(harness.url('/api/release-settings/projects/p2'), quiet);
    expect([missing.status, missing.data]).toEqual([404, { error: 'Project not found' }]);
    const refused = await axios.put(harness.url('/api/release-settings/projects/p1'), { release: { agent: 'koala' } }, quiet);
    expect([refused.status, refused.data]).toEqual([400, { error: 'koala is not an agent that releases builds' }]);
  });
});
