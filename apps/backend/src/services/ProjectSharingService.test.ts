import { describe, expect, it } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { markingHubWrites } from '../lib/hub-sync.js';
import { memoryHubStore } from '../lib/hub-store.js';
import { HubService } from './HubService.js';
import { HubSyncService, localHubSync } from './HubSyncService.js';
import { localHubSharing, ProjectSharingService } from './ProjectSharingService.js';

const now = '2026-10-21T00:00:00Z';
const ann = { id: 'ann', email: 'ann@example.com' };

async function setUp() {
  const db = markingHubWrites(new MemoryDB());
  await db.init();
  const store = memoryHubStore();
  const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) } });
  const sync = new HubSyncService({ store: db, transport: localHubSync(hub, 'combined'), origin: 'instance:combined' });
  const notices: unknown[] = [];
  const sharing = new ProjectSharingService({
    store: db, sharing: localHubSharing(hub, 'combined'), sync, dataKey: 'k'.repeat(32) as never,
    ownerRepo: async () => ({ url: 'unused' }), notify: async (_owner, _scope, notice) => { notices.push(notice); }, now: () => now,
  });
  await db.saveProject({ id: 'p1', ownerId: 'ann', name: 'Shop', createdAt: now } as never);
  await db.saveProject({ id: 'p2', ownerId: 'ann', name: 'Mine', createdAt: now } as never);
  await db.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
  await db.saveTree({ id: 't2', ownerId: 'ann', name: 'Mine', type: 'odoo' as never, projectIds: ['p2'], createdAt: now, updatedAt: now });
  await db.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
  await db.saveLeaf({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'pending', createdAt: now, updatedAt: now });
  await db.saveConversation({ id: 'channel-p1', ownerId: 'ann', kind: 'channel', treeId: 't1', projectId: 'p1', messages: [{ role: 'user', content: 'earlier talk', at: now }], createdAt: now, updatedAt: now } as never);
  await db.saveConversation({ id: 'mine', ownerId: 'ann', treeId: 't1', projectId: 'p1', messages: [], createdAt: now, updatedAt: now } as never);
  return { db, hub, store, sharing };
}

describe('sharing a project from its owner\'s instance', () => {
  it('shows what would move and what stays, moves nothing until asked, then moves the board and its chats with their history', async () => {
    const { db, store, hub, sharing } = await setUp();
    const before = await sharing.preview('ann', 'p1');
    expect(before).toEqual({ ok: true, value: { moves: { epics: 1, features: 1, stories: 1, tasks: 0, chats: 1 }, stays: expect.arrayContaining(['the project\'s secrets']) } });
    expect(await hub.mine('ann')).toEqual([]);
    expect(await sharing.preview('bo', 'p1')).toMatchObject({ ok: false, status: 404 });

    const shared = await sharing.share(ann, 'p1');
    if (!shared.ok) throw new Error(shared.why);
    const hubId = shared.value.shared!.hubProjectId;
    expect((await hub.mine('ann')).map((entry) => [entry.project.name, entry.role])).toEqual([['Shop', 'owner']]);
    const onHub = store.project(hubId);
    expect((await onHub.records('trees')).map((doc) => doc.id)).toEqual(['t1']);
    expect((await onHub.records('conversations')).map((doc) => [doc.id, (doc.messages as { content: string }[]).map((message) => message.content)])).toEqual([['channel-p1', ['earlier talk']]]);
    expect(await db.getHubLinks()).toHaveLength(1);

    expect((await sharing.share(ann, 'p1')).ok).toBe(true);
    expect(await hub.mine('ann')).toHaveLength(1);
  });

  it('takes it back: the hub forgets it and everyone on it, and the project carries on only on the instance', async () => {
    const { db, store, hub, sharing } = await setUp();
    const shared = await sharing.share(ann, 'p1');
    if (!shared.ok) throw new Error(shared.why);
    const hubId = shared.value.shared!.hubProjectId;
    await db.saveLeaf({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'running', createdAt: now, updatedAt: now });

    expect(await sharing.takeBack('ann', 'p1', 'shop')).toMatchObject({ ok: false, status: 400 });
    const back = await sharing.takeBack('ann', 'p1', 'Shop');
    expect(back).toMatchObject({ ok: true, value: { moves: { stories: 1 } } });
    expect(back.ok && back.value.shared).toBeUndefined();
    expect([await store.getProject(hubId), await hub.mine('ann'), await db.getHubLinks(), await db.hubSnapshot('leaves', 'l1')]).toEqual([undefined, [], [], undefined]);
    expect((await db.getLeaves())[0]).toMatchObject({ status: 'running' });
    expect(await sharing.takeBack('ann', 'p1', 'Shop')).toMatchObject({ ok: false, status: 409 });
  });
});
