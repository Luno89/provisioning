import axios from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { localHubSharing, localProjectGroups, ProjectSharingService } from '../../projects/services/ProjectSharingService.js';
import { memoryHubStore } from '../lib/hub-store.js';
import { HubService } from '../services/HubService.js';
import { HubSyncService, localHubSync } from '../services/HubSyncService.js';
import { projectSharingRouter } from './project-sharing.js';

const now = '2026-10-21T00:00:00Z';
const ask = { validateStatus: () => true };
const harnesses: Harness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) await harness.close(); });

async function ownerSite() {
  const hub = new HubService({ store: memoryHubStore(), invites: { send: async () => ({ link: 'l', emailed: false }) } });
  const site = await mountRouter({
    prefix: '/api/project-sharing',
    user: { id: 'ann', email: 'ann@example.com' },
    router: (db) => projectSharingRouter({
      sharing: new ProjectSharingService({
        store: db, sharing: localHubSharing(hub, 'combined'), sync: new HubSyncService({ store: db.hub, transport: localHubSync(hub, 'combined'), origin: 'instance:combined' }), dataKey: 'k'.repeat(32) as never,
        ownerRepo: async () => ({ url: 'unused' }), notify: async () => undefined, now: () => now, groups: localProjectGroups(db), republish: async () => undefined,
      }),
    }),
  });
  harnesses.push(site);
  await site.db.projects.saveProject({ id: 'p1', ownerId: 'ann', name: 'Shop', createdAt: now } as never);
  await site.db.projects.saveProject({ id: 'p2', ownerId: 'bo', name: 'Theirs', createdAt: now } as never);
  await site.db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
  await site.db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
  await site.db.projects.saveLeaf({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'pending', createdAt: now, updatedAt: now });
  return { site, hub };
}

describe('/api/project-sharing on the owner\'s instance', () => {
  it('says what sharing would send and keep, and shows a project that is not theirs as missing', async () => {
    const { site } = await ownerSite();
    const preview = await axios.get(site.url('/api/project-sharing/p1'));
    expect(preview.data).toMatchObject({ canShare: true, moves: { epics: 1, features: 1, stories: 1 } });
    const other = await axios.get(site.url('/api/project-sharing/p2'), ask);
    expect([other.status, other.data]).toEqual([404, { error: 'There is no such project.' }]);
  });

  it('checks a group as typed and suggests one from the project\'s name', async () => {
    const { site } = await ownerSite();
    expect((await axios.get(site.url('/api/project-sharing/p1/group-check'))).data).toEqual({ ok: false, suggested: 'shop' });
    expect((await axios.get(site.url('/api/project-sharing/p1/group-check?name=acme'))).data).toMatchObject({ ok: true, suggested: 'shop' });
    expect((await axios.get(site.url('/api/project-sharing/p1/group-check?name=a-b'))).data).toMatchObject({ ok: false, problem: expect.stringMatching(/no dashes/) as string });
  });

  it('shares a project under the group named, refuses one without, and takes it back only by its typed name', async () => {
    const { site, hub } = await ownerSite();
    const missing = await axios.post(site.url('/api/project-sharing/p1'), {}, ask);
    expect([missing.status, missing.data]).toEqual([400, { error: 'Name the group the project\'s apps are addressed under while it is shared.' }]);
    expect(await hub.mine('ann')).toEqual([]);

    const shared = await axios.post(site.url('/api/project-sharing/p1'), { group: 'acme' });
    expect(shared.data).toMatchObject({ group: 'acme', addresses: { scope: 'group' }, shared: { hubProjectId: expect.any(String) as string } });
    expect((await hub.mine('ann')).map((entry) => [entry.project.name, entry.role])).toEqual([['Shop', 'owner']]);
    expect(await site.db.hub.getHubLinks()).toHaveLength(1);

    const wrongName = await axios.delete(site.url('/api/project-sharing/p1'), { ...ask, data: { confirm: 'shop' } });
    expect(wrongName.status).toBe(400);
    expect(await hub.mine('ann')).toHaveLength(1);
    const back = await axios.delete<{ shared?: unknown }>(site.url('/api/project-sharing/p1'), { data: { confirm: 'Shop' } });
    expect(back.status).toBe(200);
    expect(back.data.shared).toBeUndefined();
    expect([await hub.mine('ann'), await site.db.hub.getHubLinks()]).toEqual([[], []]);
    const again = await axios.delete(site.url('/api/project-sharing/p1'), { ...ask, data: { confirm: 'Shop' } });
    expect(again.status).toBe(409);
  });
});
