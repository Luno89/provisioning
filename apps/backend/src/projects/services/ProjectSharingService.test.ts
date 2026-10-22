import { describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { memoryHubStore } from '../../hub/lib/hub-store.js';
import { HubService } from '../../hub/services/HubService.js';
import { HubSyncService, localHubSync } from '../../hub/services/HubSyncService.js';
import { localHubSharing, localProjectGroups, ProjectSharingService, type ProjectGroups } from './ProjectSharingService.js';

const now = '2026-10-21T00:00:00Z';
const ann = { id: 'ann', email: 'ann@example.com' };

async function setUp(given: { groups?: (db: Awaited<ReturnType<typeof testDatabase>>) => ProjectGroups; domain?: string } = {}) {
  const db = await testDatabase();
  const republished: number[] = [];
  const store = memoryHubStore();
  const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) } });
  const sync = new HubSyncService({ store: db.hub, transport: localHubSync(hub, 'combined'), origin: 'instance:combined' });
  const notices: unknown[] = [];
  const sharing = new ProjectSharingService({
    store: db, sharing: localHubSharing(hub, 'combined'), sync, dataKey: 'k'.repeat(32) as never,
    ownerRepo: async () => ({ url: 'unused' }), notify: async (_owner, _scope, notice) => { notices.push(notice); }, now: () => now,
    groups: given.groups ? given.groups(db) : localProjectGroups(db), republish: async () => { republished.push(1); }, ...(given.domain ? { domain: given.domain } : {}),
  });
  await db.projects.saveProject({ id: 'p1', ownerId: 'ann', name: 'Shop', createdAt: now } as never);
  await db.projects.saveProject({ id: 'p2', ownerId: 'ann', name: 'Mine', createdAt: now } as never);
  await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
  await db.projects.saveTree({ id: 't2', ownerId: 'ann', name: 'Mine', type: 'odoo' as never, projectIds: ['p2'], createdAt: now, updatedAt: now });
  await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
  await db.projects.saveLeaf({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'pending', createdAt: now, updatedAt: now });
  await db.engine.saveConversation({ id: 'channel-p1', ownerId: 'ann', kind: 'channel', treeId: 't1', projectId: 'p1', messages: [{ role: 'user', content: 'earlier talk', at: now }], createdAt: now, updatedAt: now } as never);
  await db.engine.saveConversation({ id: 'mine', ownerId: 'ann', treeId: 't1', projectId: 'p1', messages: [], createdAt: now, updatedAt: now } as never);
  return { db, hub, store, sharing, republished };
}

describe('sharing a project from its owner\'s instance', () => {
  it('shows what would move and what stays, moves nothing until asked, then moves the board and its chats with their history', async () => {
    const { db, store, hub, sharing } = await setUp();
    const before = await sharing.preview('ann', 'p1');
    expect(before).toEqual({ ok: true, value: { canShare: true, addresses: { scope: 'owner' }, moves: { epics: 1, features: 1, stories: 1, tasks: 0, chats: 1 }, stays: expect.arrayContaining(['the project\'s secrets']) } });
    expect(await hub.mine('ann')).toEqual([]);
    expect(await sharing.preview('bo', 'p1')).toMatchObject({ ok: false, status: 404 });

    const shared = await sharing.share(ann, 'p1', 'acme');
    if (!shared.ok) throw new Error(shared.why);
    const hubId = shared.value.shared!.hubProjectId;
    expect((await hub.mine('ann')).map((entry) => [entry.project.name, entry.role])).toEqual([['Shop', 'owner']]);
    const onHub = store.project(hubId);
    expect((await onHub.records('trees')).map((doc) => doc.id)).toEqual(['t1']);
    expect((await onHub.records('conversations')).map((doc) => [doc.id, (doc.messages as { content: string }[]).map((message) => message.content)])).toEqual([['channel-p1', ['earlier talk']]]);
    expect(await db.hub.getHubLinks()).toHaveLength(1);

    expect((await sharing.share(ann, 'p1', 'acme')).ok).toBe(true);
    expect(await hub.mine('ann')).toHaveLength(1);
  });

  it('takes it back: the hub forgets it and everyone on it, and the project carries on only on the instance', async () => {
    const { db, store, hub, sharing } = await setUp();
    const shared = await sharing.share(ann, 'p1', 'acme');
    if (!shared.ok) throw new Error(shared.why);
    const hubId = shared.value.shared!.hubProjectId;
    await db.projects.saveLeaf({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'running', createdAt: now, updatedAt: now });

    expect(await sharing.takeBack('ann', 'p1', 'shop')).toMatchObject({ ok: false, status: 400 });
    const back = await sharing.takeBack('ann', 'p1', 'Shop');
    expect(back).toMatchObject({ ok: true, value: { moves: { stories: 1 } } });
    expect(back.ok && back.value.shared).toBeUndefined();
    expect([await store.getProject(hubId), await hub.mine('ann'), await db.hub.getHubLinks(), await db.hub.hubSnapshot('leaves', 'l1')]).toEqual([undefined, [], [], undefined]);
    expect((await db.projects.getLeaves())[0]).toMatchObject({ status: 'running' });
    expect(await sharing.takeBack('ann', 'p1', 'Shop')).toMatchObject({ ok: false, status: 409 });
  });
});

describe('the group a shared project\'s apps are addressed under', () => {
  it('is needed to share, follows the name rules and is refused while another project holds it', async () => {
    const { sharing, republished } = await setUp();
    expect(await sharing.share(ann, 'p1', undefined)).toMatchObject({ ok: false, status: 400, why: expect.stringMatching(/Name the group/) });
    expect(await sharing.share(ann, 'p1', 'ac-me')).toMatchObject({ ok: false, status: 400, why: expect.stringMatching(/no dashes/) });
    expect(await sharing.share(ann, 'p1', 'mail')).toMatchObject({ ok: false, status: 400, why: expect.stringMatching(/kept for the platform/) });
    expect(republished).toEqual([]);
    const shared = await sharing.share(ann, 'p1', 'acme');
    expect(shared).toMatchObject({ ok: true, value: { group: 'acme', addresses: { scope: 'group' } } });
    expect(republished).toEqual([1]);
    expect(await sharing.share(ann, 'p2', 'acme')).toMatchObject({ ok: false, status: 409, why: '"acme" is taken' });
    expect(await sharing.groupCheck('ann', 'p2', 'acme')).toEqual({ ok: true, value: { ok: false, problem: '"acme" is taken', suggested: 'mine' } });
    await sharing.takeBack('ann', 'p1', 'Shop');
    expect(republished).toEqual([1, 1]);
    expect(await sharing.share(ann, 'p2', 'acme')).toMatchObject({ ok: true, value: { group: 'acme' } });
  });

  it('suggests a group from the project\'s name and says what its apps would be addressed', async () => {
    const { db, sharing } = await setUp({ domain: 'koala.dev' });
    expect(await sharing.groupCheck('ann', 'p1', undefined)).toEqual({ ok: true, value: { ok: false, suggested: 'shop' } });
    expect(await sharing.groupCheck('ann', 'p1', 'acme')).toEqual({ ok: true, value: { ok: true, suggested: 'shop', example: '<app>-acme.koala.dev' } });
    expect(await sharing.groupCheck('ann', 'p1', 'a-b')).toMatchObject({ ok: true, value: { ok: false, problem: expect.stringMatching(/no dashes/) } });
    expect(await sharing.groupCheck('bo', 'p1', 'acme')).toMatchObject({ ok: false, status: 404 });
    await db.infrastructure.saveDeployment({ id: 'd1', name: 'Shop Front', gitappProjectId: 'p1', clusterId: 'c1', appType: 'gitapp', status: 'running', createdAt: now } as never);
    expect(await sharing.groupCheck('ann', 'p1', 'acme')).toMatchObject({ ok: true, value: { example: 'shop-front-acme.koala.dev' } });
    const shared = await sharing.share(ann, 'p1', 'acme');
    expect(shared).toMatchObject({ ok: true, value: { group: 'acme', addresses: { scope: 'group', example: 'shop-front-acme.koala.dev' } } });
  });

  it('is claimed where the instance is routed before the hub hears of it, and released when the project is taken back or deleted', async () => {
    const calls: string[] = [];
    const groups = (): ProjectGroups => ({
      check: async (name) => (name === 'globex' ? '"globex" is taken' : null),
      claim: async (projectId, name) => { calls.push(`claim ${projectId} ${name}`); if (name === 'globex') throw new Error('"globex" is taken'); },
      release: async (projectId) => { calls.push(`release ${projectId}`); },
    });
    const { db, hub, sharing } = await setUp({ groups });
    expect(await sharing.groupCheck('ann', 'p1', 'globex')).toMatchObject({ ok: true, value: { ok: false, problem: '"globex" is taken' } });
    expect(await sharing.share(ann, 'p1', 'globex')).toEqual({ ok: false, status: 409, why: '"globex" is taken' });
    expect(await hub.mine('ann')).toEqual([]);
    await sharing.share(ann, 'p1', 'acme');
    expect((await db.hub.getHubLinks())[0]).toMatchObject({ projectId: 'p1', group: 'acme' });
    expect(await sharing.groupCheck('ann', 'p1', 'acme')).toMatchObject({ ok: true, value: { ok: true } });
    await sharing.takeBackForDeletion('ann', 'p1');
    expect(calls).toEqual(['claim p1 globex', 'claim p1 acme', 'release p1']);
  });
});
