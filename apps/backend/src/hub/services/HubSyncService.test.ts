import { describe, expect, it, vi } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { memoryHubStore } from '../lib/hub-store.js';
import { CHANGES_PAGE, HubService } from './HubService.js';
import { HubSyncService, localHubSync } from './HubSyncService.js';
import { HubRelay } from './HubRelay.js';
import { HubInstanceWork } from './HubInstanceWork.js';
import type { Leaf } from '../../projects/lib/leaves.js';

const ann = { id: 'ann', email: 'ann@example.com' };
const now = '2026-10-21T00:00:00Z';

async function setUp() {
  const db = await testDatabase();
  const store = memoryHubStore();
  const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) } });
  const made = await hub.create(ann, { name: 'Shop', origin: { instanceId: 'combined', projectId: 'p1' } });
  if (!made.ok) throw new Error(made.why);
  const hubId = made.value.project.id;
  const sync = new HubSyncService({ store: db.hub, transport: localHubSync(hub, 'combined'), origin: 'instance:combined' });
  const onHub = store.project(hubId);
  return { db, hub, sync, onHub, hubId };
}

const leaf = (fields: Partial<Leaf> = {}): Leaf => ({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'pending', createdAt: now, updatedAt: now, ...fields });

describe('keeping a shared project\'s board in step with the hub', () => {
  it('sends nothing until a project is shared, then only what belongs to it, never a private chat or another project', async () => {
    const { db, sync, onHub, hubId } = await setUp();
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    expect(await db.hub.hubDirty(10)).toEqual([]);

    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await db.projects.saveTree({ id: 't2', ownerId: 'ann', name: 'Mine', type: 'odoo' as never, projectIds: ['p2'], createdAt: now, updatedAt: now });
    await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
    await db.projects.saveLeaf(leaf());
    await db.engine.saveConversation({ id: 'channel-p1', ownerId: 'ann', kind: 'channel', treeId: 't1', projectId: 'p1', messages: [], createdAt: now, updatedAt: now } as never);
    await db.engine.saveConversation({ id: 'mine', ownerId: 'ann', treeId: 't1', projectId: 'p1', messages: [{ role: 'user', content: 'private', at: now }], createdAt: now, updatedAt: now } as never);
    await db.engine.appendMessage('ann', 'channel-p1', { role: 'user', content: 'hello', at: '2026-10-21T00:00:01Z', author: { kind: 'person', id: 'ann' } });

    await sync.once();
    expect(await db.hub.hubDirty(10)).toEqual([]);
    expect((await onHub.records('trees')).map((doc) => doc.id)).toEqual(['t1']);
    expect((await onHub.records('leaves')).map((doc) => [doc.id, doc.status])).toEqual([['l1', 'pending']]);
    expect((await onHub.records('conversations')).map((doc) => [doc.id, (doc.messages as { content: string }[]).map((message) => message.content)])).toEqual([['channel-p1', ['hello']]]);

    await sync.once();
    expect((await onHub.changes(0, 100)).length).toBe(4);
  });

  it('brings a member\'s change down and keeps both when the engine changed another field meanwhile; a deleted story goes on both', async () => {
    const { db, sync, onHub, hubId } = await setUp();
    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
    await db.projects.saveLeaf(leaf());
    await sync.once();

    const memberPatch = { set: { priority: 1 } };
    await onHub.putRecord('leaves', { ...(await onHub.record('leaves', 'l1'))!, priority: 1 });
    await onHub.logChange({ origin: 'person:bo', change: { kind: 'leaves', id: 'l1', patch: memberPatch }, at: now });
    await db.projects.saveLeaf(leaf({ status: 'running' }));

    await sync.once();
    expect(await db.hub.syncedRecord('leaves', 'l1')).toMatchObject({ status: 'running', priority: 1 });
    await sync.once();
    expect(await onHub.record('leaves', 'l1')).toMatchObject({ status: 'running', priority: 1 });
    expect((await db.hub.getHubLinks())[0]!.pulledThrough).toBe((await onHub.changes(0, 100)).at(-1)!.seq);

    await db.projects.deleteLeaf('l1');
    await sync.once();
    expect(await onHub.record('leaves', 'l1')).toBeUndefined();
    expect(await db.hub.hubSnapshot('leaves', 'l1')).toBeUndefined();
  });

  it('pulls every page when members changed more than one page holds', async () => {
    const { db, sync, onHub, hubId } = await setUp();
    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
    await db.projects.saveLeaf(leaf());
    await sync.once();
    for (let n = 1; n <= CHANGES_PAGE + 50; n += 1) {
      await onHub.putRecord('leaves', { ...(await onHub.record('leaves', 'l1'))!, priority: n });
      await onHub.logChange({ origin: 'person:bo', change: { kind: 'leaves', id: 'l1', patch: { set: { priority: n } } }, at: now });
    }
    await sync.once();
    expect(await db.hub.syncedRecord('leaves', 'l1')).toMatchObject({ priority: CHANGES_PAGE + 50 });
    expect((await db.hub.getHubLinks())[0]!.pulledThrough).toBe((await onHub.changes(0, 10_000)).at(-1)!.seq);
  });

  it('keeps a change waiting while the hub cannot be reached, and sends it once it can', async () => {
    const { db, onHub, hub, hubId } = await setUp();
    let down = true;
    const transport = localHubSync(hub, 'combined');
    const sync = new HubSyncService({ store: db.hub, origin: 'instance:combined', transport: { ...transport, push: (link, changes) => (down ? Promise.reject(new Error('unreachable')) : transport.push(link, changes)) } });
    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await sync.once();
    expect((await db.hub.hubDirty(10)).length).toBe(1);
    down = false;
    await sync.once();
    expect([await db.hub.hubDirty(10), (await onHub.records('trees')).length]).toEqual([[], 1]);
  });

  it('stops sharing on the instance when the project was deleted on the hub', async () => {
    const { db, hub, sync, hubId } = await setUp();
    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await sync.once();
    await hub.delete('ann', hubId, 'Shop');
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop again', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await sync.once();
    expect([await db.hub.getHubLinks(), await db.hub.hubSnapshot('trees', 't1'), await db.hub.hubDirty(10)]).toEqual([[], undefined, []]);
  });
});


describe('members working a shared project from the hub', () => {
  async function shared() {
    const db = await testDatabase();
    const store = memoryHubStore();
    const relay = new HubRelay(Date.now, 60_000);
    const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) }, relay });
    const made = await hub.create(ann, { name: 'Shop', origin: { instanceId: 'combined', projectId: 'p1' } });
    if (!made.ok) throw new Error(made.why);
    const hubId = made.value.project.id;
    for (const [personId, role] of [['cy', 'client'], ['bo', 'collaborator']] as const) {
      await store.project(hubId).saveMember({ personId, email: `${personId}@example.com`, role, joinedAt: now });
      await store.addMembership(personId, hubId);
    }
    const did: [string, ...unknown[]][] = [];
    const ok = { ok: true as const };
    const files: Record<string, string> = { 'designs/logo.png': 'png', 'contracts/nda.pdf': 'pdf' };
    const work = new HubInstanceWork({
      store: db,
      status: async (ownerId, project, treeIds) => ({ at: 'now', releases: [{ id: 'r1', state: 'live', commit: 'abc', startedAt: '1' }], runs: [], treeRuns: Object.fromEntries(treeIds.map((id) => [id, { state: 'idle' }])), addresses: { owner: ownerId, project: project.id } }),
      act: {
        approvePlan: async (...args) => { did.push(['approvePlan', ...args]); return ok; },
        rejectPlan: async (...args) => { did.push(['rejectPlan', ...args]); return ok; },
        orderStories: async (...args) => { did.push(['orderStories', ...args]); return ok; },
        orderFeatures: async (...args) => { did.push(['orderFeatures', ...args]); return ok; },
        decideTask: async (...args) => { did.push(['decideTask', ...args]); return ok; },
        askKoala: async (ownerId, conversation, note) => { did.push(['askKoala', ownerId, conversation.id, note]); return ok; },
        openChat: async (...args) => { did.push(['openChat', ...args]); return ok; },
      },
      live: { turns: async () => ({ entries: [] }), procedure: async () => undefined, extensions: async () => [] },
      files: {
        list: async (_owner, _scope, dir) => ({ ok: true, value: Object.keys(files).filter((path) => (dir ? path.startsWith(`${dir}/`) : true)).map((path) => (dir ? { name: path.split('/').pop()!, path, type: 'file' as const } : { name: path.split('/')[0]!, path: path.split('/')[0]!, type: 'dir' as const })) }),
        search: async () => ({ ok: true, value: [] }),
        clientFiles: async () => (await db.projects.getProjects()).find((project) => project.id === 'p1')?.clientFiles ?? [],
        forClients: async (_scope, path, on) => { const project = (await db.projects.getProjects()).find((entry) => entry.id === 'p1')!; const next = on ? [...(project.clientFiles ?? []), path] : []; await db.projects.saveProjectInfo({ id: 'p1', clientFiles: next }); return { ok: true, value: { clientFiles: next } }; },
        download: async () => ({ ok: false, status: 404, why: 'none' }),
        upload: async () => ({ ok: true, value: { path: 'x' } }),
        makeFolder: async () => ({ ok: true, value: { path: 'x' } }),
        move: async () => ({ ok: true, value: { path: 'x' } }),
        remove: async () => ({ ok: true, value: { path: 'x' } }),
      },
    });
    const sync = new HubSyncService({ store: db.hub, transport: localHubSync(hub, 'combined'), origin: 'instance:combined', work: () => work, retryMs: 10 });
    await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: 'ann', createdAt: now } as never);
    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
    await db.projects.saveLeaf(leaf());
    await db.projects.saveLeaf(leaf({ id: 'l2', title: 'Refund' }));
    await db.engine.saveConversation({ id: 'channel-p1', ownerId: 'ann', kind: 'channel', treeId: 't1', projectId: 'p1', messages: [], createdAt: now, updatedAt: now } as never);
    await sync.once();
    await vi.waitFor(() => expect(relay.online(hubId)).toBe(true));
    return { db, hub, hubId, sync, did, relay, store };
  }

  it('brings a client\'s question to Koala on the owner\'s instance once the message itself has arrived, naming who asked', async () => {
    const { db, hub, hubId, sync, did, relay } = await shared();
    const posted = await hub.post({ id: 'cy', email: 'cy@example.com' }, hubId, 'channel-p1', { content: 'can the button be green?', askKoala: true });
    if (!posted.ok) throw new Error(posted.why);
    expect(posted.value.asked?.state).toBe('waiting');
    await sync.once();
    const message = (await db.engine.getConversation('ann', 'channel-p1'))!.messages.find((entry) => entry.content === 'can the button be green?');
    expect(message?.author).toEqual({ kind: 'person', id: 'cy' });
    expect(did).toEqual([['askKoala', 'ann', 'channel-p1', { at: posted.value.message.at, content: 'can the button be green?' }]]);
    expect((await db.hub.getHubLinks())[0]!.members?.map((member) => member.email).sort()).toEqual(['ann@example.com', 'bo@example.com', 'cy@example.com']);
    const board = await hub.boardView('cy', hubId);
    expect(board.ok && board.value.requests.map((request) => request.state)).toEqual(['done']);
    sync.stop();
    relay.stop();
  });

  it('posts a collaborator\'s message without asking Koala, which answers them from their own instance', async () => {
    const { hub, hubId, sync, did, relay } = await shared();
    const posted = await hub.post({ id: 'bo', email: 'bo@example.com' }, hubId, 'channel-p1', { content: '@koala what is left?' });
    expect(posted.ok && [posted.value.asked, posted.value.notAsked !== undefined]).toEqual([undefined, true]);
    await sync.once();
    expect(did).toEqual([]);
    sync.stop();
    relay.stop();
  });

  it('carries out a collaborator\'s new order of stories as the owner, refuses a client\'s, and refuses one the instance does not know', async () => {
    const { hub, hubId, sync, did, relay, store } = await shared();
    const ordered = await hub.request({ id: 'bo', email: 'bo@example.com' }, hubId, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'] });
    expect(ordered.ok).toBe(true);
    const refused = await hub.request({ id: 'cy', email: 'cy@example.com' }, hubId, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'] });
    expect(refused).toMatchObject({ ok: false, status: 403 });
    await store.project(hubId).saveRequest({ id: 'forged', kind: 'accept-task', input: { taskId: 'not-here' }, by: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, at: now, after: 0, state: 'waiting' });
    await sync.once();
    expect(did).toEqual([['orderStories', 'ann', 'b1', ['l2', 'l1']]]);
    const settled = await store.project(hubId).requests();
    expect(settled.map((request) => [request.kind, request.state]).sort()).toEqual([['accept-task', 'refused'], ['order-stories', 'done']]);
    sync.stop();
    relay.stop();
  });

  it('sends what is live once, shows a client only what is live, and nothing again until it changes', async () => {
    const { hub, hubId, sync, relay, store } = await shared();
    const first = await store.project(hubId).status();
    expect(first?.treeRuns).toEqual({ t1: { state: 'idle' } });
    await sync.once();
    expect((await store.project(hubId).status())?.at).toBe(first?.at);
    const seen = await hub.boardView('cy', hubId);
    expect(seen.ok && seen.value.board.status).toEqual({ at: first!.at, releases: [{ id: 'r1', state: 'live', startedAt: '1' }], runs: [], treeRuns: {}, addresses: { owner: 'ann', project: 'p1' } });
    sync.stop();
    relay.stop();
  });

  it('answers a member\'s file listing through the relay, showing a client only what was shared with clients', async () => {
    const { hub, hubId, sync, relay } = await shared();
    const asOwner = await hub.relay({ id: 'ann', email: 'ann@example.com' }, hubId, 'files.list', { dir: '' });
    expect(asOwner.ok && asOwner.value.kind === 'json' && (asOwner.value.body as { path: string }[]).map((entry) => entry.path)).toEqual(['designs', 'contracts']);
    const before = await hub.relay({ id: 'cy', email: 'cy@example.com' }, hubId, 'files.list', { dir: '' });
    expect(before.ok && before.value.kind === 'json' && before.value.body).toEqual([]);
    expect(await hub.relay({ id: 'cy', email: 'cy@example.com' }, hubId, 'files.for-clients', { path: 'designs', on: true })).toMatchObject({ ok: false, status: 403 });
    const sharedOut = await hub.relay({ id: 'bo', email: 'bo@example.com' }, hubId, 'files.for-clients', { path: 'designs/logo.png', on: true });
    expect(sharedOut.ok && sharedOut.value.kind === 'json' && sharedOut.value.status).toBe(200);
    const after = await hub.relay({ id: 'cy', email: 'cy@example.com' }, hubId, 'files.list', { dir: 'designs' });
    expect(after.ok && after.value.kind === 'json' && (after.value.body as { path: string }[]).map((entry) => entry.path)).toEqual(['designs/logo.png']);
    expect(await hub.relay({ id: 'cy', email: 'cy@example.com' }, hubId, 'turns', { turnId: 'x' })).toMatchObject({ ok: false, status: 403 });
    sync.stop();
    relay.stop();
  });
});
