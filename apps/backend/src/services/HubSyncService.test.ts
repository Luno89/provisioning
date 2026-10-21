import { describe, expect, it } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { markingHubWrites } from '../lib/hub-sync.js';
import { memoryHubStore } from '../lib/hub-store.js';
import { HubService } from './HubService.js';
import { HubSyncService, localHubSync } from './HubSyncService.js';
import type { Leaf } from '../lib/leaves.js';

const ann = { id: 'ann', email: 'ann@example.com' };
const now = '2026-10-21T00:00:00Z';

async function setUp() {
  const db = markingHubWrites(new MemoryDB());
  await db.init();
  const store = memoryHubStore();
  const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) } });
  const made = await hub.create(ann, { name: 'Shop', origin: { instanceId: 'combined', projectId: 'p1' } });
  if (!made.ok) throw new Error(made.why);
  const hubId = made.value.project.id;
  const sync = new HubSyncService({ store: db, transport: localHubSync(hub, 'combined'), origin: 'instance:combined' });
  const onHub = store.project(hubId);
  return { db, hub, sync, onHub, hubId };
}

const leaf = (fields: Partial<Leaf> = {}): Leaf => ({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'pending', createdAt: now, updatedAt: now, ...fields });

describe('keeping a shared project\'s board in step with the hub', () => {
  it('sends nothing until a project is shared, then only what belongs to it, never a private chat or another project', async () => {
    const { db, sync, onHub, hubId } = await setUp();
    await db.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    expect(await db.hubDirty(10)).toEqual([]);

    await db.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    await db.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await db.saveTree({ id: 't2', ownerId: 'ann', name: 'Mine', type: 'odoo' as never, projectIds: ['p2'], createdAt: now, updatedAt: now });
    await db.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
    await db.saveLeaf(leaf());
    await db.saveConversation({ id: 'channel-p1', ownerId: 'ann', kind: 'channel', treeId: 't1', projectId: 'p1', messages: [], createdAt: now, updatedAt: now } as never);
    await db.saveConversation({ id: 'mine', ownerId: 'ann', treeId: 't1', projectId: 'p1', messages: [{ role: 'user', content: 'private', at: now }], createdAt: now, updatedAt: now } as never);
    await db.appendMessage('ann', 'channel-p1', { role: 'user', content: 'hello', at: '2026-10-21T00:00:01Z', author: { kind: 'person', id: 'ann' } });

    await sync.once();
    expect(await db.hubDirty(10)).toEqual([]);
    expect((await onHub.records('trees')).map((doc) => doc.id)).toEqual(['t1']);
    expect((await onHub.records('leaves')).map((doc) => [doc.id, doc.status])).toEqual([['l1', 'pending']]);
    expect((await onHub.records('conversations')).map((doc) => [doc.id, (doc.messages as { content: string }[]).map((message) => message.content)])).toEqual([['channel-p1', ['hello']]]);

    await sync.once();
    expect((await onHub.changes(0, 100)).length).toBe(4);
  });

  it('brings a member\'s change down and keeps both when the engine changed another field meanwhile; a deleted story goes on both', async () => {
    const { db, sync, onHub, hubId } = await setUp();
    await db.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    await db.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await db.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
    await db.saveLeaf(leaf());
    await sync.once();

    const memberPatch = { set: { priority: 1 } };
    await onHub.putRecord('leaves', { ...(await onHub.record('leaves', 'l1'))!, priority: 1 });
    await onHub.logChange({ origin: 'person:bo', change: { kind: 'leaves', id: 'l1', patch: memberPatch }, at: now });
    await db.saveLeaf(leaf({ status: 'running' }));

    await sync.once();
    expect(await db.syncedRecord('leaves', 'l1')).toMatchObject({ status: 'running', priority: 1 });
    await sync.once();
    expect(await onHub.record('leaves', 'l1')).toMatchObject({ status: 'running', priority: 1 });
    expect((await db.getHubLinks())[0]!.pulledThrough).toBe((await onHub.changes(0, 100)).at(-1)!.seq);

    await db.deleteLeaf('l1');
    await sync.once();
    expect(await onHub.record('leaves', 'l1')).toBeUndefined();
    expect(await db.hubSnapshot('leaves', 'l1')).toBeUndefined();
  });

  it('keeps a change waiting while the hub cannot be reached, and sends it once it can', async () => {
    const { db, onHub, hub, hubId } = await setUp();
    let down = true;
    const transport = localHubSync(hub, 'combined');
    const sync = new HubSyncService({ store: db, origin: 'instance:combined', transport: { push: (link, changes) => (down ? Promise.reject(new Error('unreachable')) : transport.push(link, changes)), pull: transport.pull } });
    await db.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    await db.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await sync.once();
    expect((await db.hubDirty(10)).length).toBe(1);
    down = false;
    await sync.once();
    expect([await db.hubDirty(10), (await onHub.records('trees')).length]).toEqual([[], 1]);
  });

  it('stops sharing on the instance when the project was deleted on the hub', async () => {
    const { db, hub, sync, hubId } = await setUp();
    await db.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    await db.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await sync.once();
    await hub.delete('ann', hubId, 'Shop');
    await db.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop again', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await sync.once();
    expect([await db.getHubLinks(), await db.hubSnapshot('trees', 't1'), await db.hubDirty(10)]).toEqual([[], undefined, []]);
  });
});

