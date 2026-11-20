import { anyOf } from '../../platform/lib/test-matchers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProcessRun } from '@koala/engine-core/processes';
import { nodeProcesses } from '@koala/engine-core/node-processes';
import { testDatabase } from '../../platform/lib/test-database.js';
import { memoryHubStore } from '../testing/memory-hub-store.js';
import { CHANGES_PAGE, HubService } from './HubService.js';
import { HubSyncService, type HubRepoSides } from './HubSyncService.js';
import { localHubSync } from '../testing/in-process-hub.js';
import { HubRelay } from './HubRelay.js';
import { HubInstanceWork } from './HubInstanceWork.js';
import type { Leaf } from '../../projects/lib/leaves.js';
import { ProjectSharingService } from '../../projects/services/ProjectSharingService.js';
import { localHubSharing, localProjectGroups } from '../../projects/testing/in-process-sharing.js';
import type { ConversationNotice } from '../../engine/index.js';

const ann = { id: 'ann', email: 'ann@example.com' };
const now = '2026-10-21T00:00:00Z';

async function setUp() {
  const db = await testDatabase();
  const store = memoryHubStore();
  const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) } });
  const made = await hub.create(ann, { name: 'Shop', origin: { instanceId: 'i1', projectId: 'p1' } });
  if (!made.ok) throw new Error(made.why);
  const hubId = made.value.project.id;
  const sync = new HubSyncService({ store: db.hub, transport: localHubSync(hub, 'i1'), origin: 'instance:i1' });
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

  it('asked for a pass while one runs, answers only after a pass that began after it was asked', async () => {
    const { db, onHub, hub, hubId } = await setUp();
    const transport = localHubSync(hub, 'i1');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let pulls = 0;
    const sync = new HubSyncService({ store: db.hub, origin: 'instance:i1', transport: { ...transport, pull: async (...args) => { pulls += 1; if (pulls === 1) await held; return transport.pull(...args); } } });
    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    const first = sync.once();
    await vi.waitFor(() => expect(pulls).toBe(1));
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    const asked = sync.once();
    const alsoAsked = sync.once();
    release();
    await Promise.all([first, asked, alsoAsked]);
    expect((await onHub.records('trees')).length).toBe(1);
    expect(pulls).toBe(2);
  });

  it('keeps a change waiting while the hub cannot be reached, and sends it once it can', async () => {
    const { db, onHub, hub, hubId } = await setUp();
    let down = true;
    const transport = localHubSync(hub, 'i1');
    const sync = new HubSyncService({ store: db.hub, origin: 'instance:i1', transport: { ...transport, push: (link, changes) => (down ? Promise.reject(new Error('unreachable')) : transport.push(link, changes)) } });
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
    const relay = new HubRelay();
    const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) }, relay });
    const made = await hub.create(ann, { name: 'Shop', origin: { instanceId: 'i1', projectId: 'p1' } });
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
        askKoala: async (ownerId, conversation, note, actingFor) => { did.push(['askKoala', ownerId, conversation.id, note, actingFor]); return ok; },
        openChat: async (...args) => { did.push(['openChat', ...args]); return ok; },
        memberRemoved: async (revoked) => { did.push(['memberRemoved', revoked]); },
      },
      live: {
        turns: async () => ({ entries: [] }),
        turnLog: async (_owner, turnId) => (turnId === 'grove-run-t1~1' ? [{ events: [{ type: 'run.started', runId: 'r1', agentId: 'grove', loopId: 'grove-run' } as never] }] : []),
        procedure: async (_owner, id) => ({ procedure: { id }, mine: false }),
        endings: async (_owner, runIds) => ({ endings: runIds.map((runId) => ({ runId, ended: { how: 'revoked', revokedBecause: 'signed-out-everywhere', at: 'now' } })) }),
        extensions: async () => [],
      },
      files: {
        list: async (_owner, _scope, dir) => ({ ok: true, value: Object.keys(files).filter((path) => (dir ? path.startsWith(`${dir}/`) : true)).map((path) => (dir ? { name: path.split('/').pop()!, path, type: 'file' as const } : { name: path.split('/')[0]!, path: path.split('/')[0]!, type: 'dir' as const })) }),
        search: async () => ({ ok: true, value: [] }),
        download: async () => ({ ok: false, status: 404, why: 'none' }),
        upload: async (_owner, _scope, path, _body, _size, _type, options) => {
          if (files[path] && !options.replace) return { ok: false, status: 409, why: `${path} is already there, and it may not be replaced` };
          files[path] = 'new';
          return { ok: true, value: { path } };
        },
        makeFolder: async () => ({ ok: true, value: { path: 'x' } }),
        move: async () => ({ ok: true, value: { path: 'x' } }),
        remove: async () => ({ ok: true, value: { path: 'x' } }),
      },
    });
    const sync = new HubSyncService({ store: db.hub, transport: localHubSync(hub, 'i1'), origin: 'instance:i1', work: () => work });
    await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: 'ann', createdAt: now } as never);
    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: hubId, pulledThrough: 0, sharedAt: now });
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
    await db.projects.saveLeaf(leaf());
    await db.projects.saveLeaf(leaf({ id: 'l2', title: 'Refund' }));
    await db.engine.saveConversation({ id: 'channel-p1', ownerId: 'ann', kind: 'channel', treeId: 't1', projectId: 'p1', messages: [], createdAt: now, updatedAt: now } as never);
    await sync.start();
    await sync.once();
    expect(relay.online('i1')).toBe(true);
    return { db, hub, hubId, sync, did, relay, store };
  }

  it('brings a client\'s question to Koala on the owner\'s instance once the message itself has arrived, naming who asked', async () => {
    const { db, hub, hubId, sync, did } = await shared();
    const posted = await hub.post({ id: 'cy', email: 'cy@example.com' }, hubId, 'channel-p1', { content: 'can the button be green?', askKoala: true });
    if (!posted.ok) throw new Error(posted.why);
    expect(posted.value.asked?.state).toBe('waiting');
    await sync.once();
    const message = (await db.engine.getConversation('ann', 'channel-p1'))!.messages.find((entry) => entry.content === 'can the button be green?');
    expect(message?.author).toEqual({ kind: 'person', id: 'cy' });
    expect(did).toEqual([['askKoala', 'ann', 'channel-p1', { at: posted.value.message.at, content: 'can the button be green?' }, { personId: 'cy', email: 'cy@example.com', role: 'client', projectId: 'p1', hubProjectId: hubId }]]);
    expect((await db.hub.getHubLinks())[0]!.members?.map((member) => member.email).sort()).toEqual(['ann@example.com', 'bo@example.com', 'cy@example.com']);
    const board = await hub.boardView('cy', hubId);
    expect(board.ok && board.value.requests.map((request) => request.state)).toEqual(['done']);
    await sync.stop();
  });

  it('posts a collaborator\'s message without asking Koala, which answers them from their own instance', async () => {
    const { hub, hubId, sync, did } = await shared();
    const posted = await hub.post({ id: 'bo', email: 'bo@example.com' }, hubId, 'channel-p1', { content: '@koala what is left?' });
    expect(posted.ok && [posted.value.asked, posted.value.notAsked !== undefined]).toEqual([undefined, true]);
    await sync.once();
    expect(did).toEqual([]);
    await sync.stop();
  });

  it('carries out a collaborator\'s new order of stories as the owner, refuses a client\'s, and refuses one the instance does not know', async () => {
    const { hub, hubId, sync, did, store } = await shared();
    const ordered = await hub.request({ id: 'bo', email: 'bo@example.com' }, hubId, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'] });
    expect(ordered.ok).toBe(true);
    const refused = await hub.request({ id: 'cy', email: 'cy@example.com' }, hubId, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'] });
    expect(refused).toMatchObject({ ok: false, status: 403 });
    await store.project(hubId).saveRequest({ id: 'forged', kind: 'accept-task', input: { taskId: 'not-here' }, by: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, at: now, after: 0, state: 'waiting' });
    await sync.once();
    expect(did).toEqual([['orderStories', 'ann', 'b1', ['l2', 'l1']]]);
    const settled = await store.project(hubId).requests();
    expect(settled.map((request) => [request.kind, request.state]).sort()).toEqual([['accept-task', 'refused'], ['order-stories', 'done']]);
    await sync.stop();
  });

  it('carries out a member\'s removal on the owner\'s instance as a revocation of that shared project, and takes it from nobody but the hub', async () => {
    const { hub, hubId, sync, did, store } = await shared();
    expect(await hub.request({ id: 'bo', email: 'bo@example.com' }, hubId, { kind: 'member-removed', personId: 'cy' })).toMatchObject({ ok: false, status: 400 });
    expect((await hub.remove('ann', hubId, 'cy')).ok).toBe(true);
    await store.project(hubId).saveRequest({ id: 'forged', kind: 'member-removed', input: { personId: 'ann' }, by: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, at: now, after: 0, state: 'waiting' });
    await sync.once();
    expect(did).toEqual([['memberRemoved', { personId: 'cy', because: 'removed-from-shared-project', at: anyOf(String), sharedProjectId: hubId }]]);
    const settled = await store.project(hubId).requests();
    expect(settled.map((request) => [request.id === 'forged' ? 'forged' : request.kind, request.state]).sort()).toEqual([['forged', 'refused'], ['member-removed', 'done']]);
    await sync.stop();
  });

  it('sends what is live once, shows a client all of it, and nothing again until it changes', async () => {
    const { hub, hubId, sync, store } = await shared();
    const first = await store.project(hubId).status();
    expect(first?.treeRuns).toEqual({ t1: { state: 'idle' } });
    await sync.once();
    expect((await store.project(hubId).status())?.at).toBe(first?.at);
    const seen = await hub.boardView('cy', hubId);
    expect(seen.ok && seen.value.board.status).toEqual({ at: first!.at, releases: [{ id: 'r1', state: 'live', commit: 'abc', startedAt: '1' }], runs: [], treeRuns: { t1: { state: 'idle' } }, addresses: { owner: 'ann', project: 'p1' } });
    await sync.stop();
  });

  it('answers every member\'s file listing and the run feed through the relay, and lets only owners and collaborators move or remove files', async () => {
    const { hub, hubId, sync } = await shared();
    const cy = { id: 'cy', email: 'cy@example.com' };
    for (const who of [{ id: 'ann', email: 'ann@example.com' }, cy]) {
      const listed = await hub.relay(who, hubId, 'files.list', { dir: '' });
      expect(listed.ok && listed.value.kind === 'json' && (listed.value.body as { path: string }[]).map((entry) => entry.path)).toEqual(['designs', 'contracts']);
    }
    const inside = await hub.relay(cy, hubId, 'files.list', { dir: 'contracts' });
    expect(inside.ok && inside.value.kind === 'json' && (inside.value.body as { path: string }[]).map((entry) => entry.path)).toEqual(['contracts/nda.pdf']);
    expect(await hub.relay(cy, hubId, 'files.remove', { path: 'contracts/nda.pdf' })).toMatchObject({ ok: false, status: 403, why: 'only an owner or a collaborator can move or remove files' });
    expect(await hub.relay(cy, hubId, 'files.move', { from: 'contracts/nda.pdf', to: 'nda.pdf' })).toMatchObject({ ok: false, status: 403 });
    const moved = await hub.relay({ id: 'bo', email: 'bo@example.com' }, hubId, 'files.move', { from: 'contracts/nda.pdf', to: 'nda.pdf' });
    expect(moved.ok && moved.value.kind === 'json' && moved.value.status).toBe(200);
    const upload = () => ({ stream: Readable.from(['new']), type: 'text/plain', size: 3 });
    expect(await hub.relay(cy, hubId, 'files.upload', { path: 'contracts/nda.pdf' }, upload())).toMatchObject({ ok: true, value: { kind: 'json', status: 409 } });
    const added = await hub.relay(cy, hubId, 'files.upload', { path: 'contracts/brief.pdf' }, upload());
    expect(added.ok && added.value.kind === 'json' && added.value.status).toBe(200);
    const replaced = await hub.relay({ id: 'bo', email: 'bo@example.com' }, hubId, 'files.upload', { path: 'contracts/nda.pdf' }, upload());
    expect(replaced.ok && replaced.value.kind === 'json' && replaced.value.status).toBe(200);
    const uploaded = await hub.relay(cy, hubId, 'files.folder', { path: 'from-cy' });
    expect(uploaded.ok && uploaded.value.kind === 'json' && uploaded.value.status).toBe(200);
    const feed = await hub.relay(cy, hubId, 'turns', { turnId: 'grove-run-t1~1' });
    expect(feed.ok && feed.value.kind === 'json' && feed.value.status).toBe(200);
    const statusOf = async (args: Record<string, string>) => { const got = await hub.relay(cy, hubId, 'procedure', args); return got.ok && got.value.kind === 'json' ? got.value.status : got; };
    expect(await statusOf({ id: 'grove-run', turnId: 'grove-run-t1~1' })).toBe(200);
    expect(await statusOf({ id: 'my-private-procedure', turnId: 'grove-run-t1~1' })).toBe(404);
    expect(await statusOf({ id: 'grove-run', turnId: 'grove-run-other~1' })).toBe(404);
    expect(await statusOf({ id: 'grove-run' })).toBe(404);
    const endings = await hub.relay(cy, hubId, 'endings', { turnId: 'grove-run-t1~1', ids: ['grove-run-t1~1', 'grove-run-t1~1-executor-1', 'run-of-another-project'] } as never);
    expect(endings.ok && endings.value.kind === 'json' && endings.value.body).toEqual({ endings: [
      { runId: 'grove-run-t1~1', ended: { how: 'revoked', revokedBecause: 'signed-out-everywhere', at: 'now' } },
      { runId: 'grove-run-t1~1-executor-1', ended: { how: 'revoked', revokedBecause: 'signed-out-everywhere', at: 'now' } },
    ] });
    const elsewhere = await hub.relay(cy, hubId, 'endings', { turnId: 'grove-run-other~1', ids: ['grove-run-other~1'] } as never);
    expect(elsewhere.ok && elsewhere.value.kind === 'json' && elsewhere.value.status).toBe(404);
    await sync.stop();
  });
});

const run = promisify(execFile);

describe('keeping main in step with the hub\'s, with real git', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

  async function bare(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-sync-svc-'));
    dirs.push(dir);
    await run('git', ['init', '--bare', '--quiet', '--initial-branch=main', dir]);
    return dir;
  }

  async function commit(repo: string, file: string, content: string): Promise<string> {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-sync-svc-work-'));
    dirs.push(work);
    const git = (...args: string[]) => run('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    await run('git', ['clone', '--quiet', repo, work]);
    if (!(await git('rev-parse', '--verify', '--quiet', 'HEAD').then(() => true, () => false))) await git('checkout', '--quiet', '-b', 'main');
    await fs.writeFile(path.join(work, file), content);
    await git('add', file);
    await git('commit', '--quiet', '-m', `${file}: ${content}`);
    await git('push', '--quiet', 'origin', 'HEAD:refs/heads/main');
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  }

  async function withRepos() {
    const db = await testDatabase();
    const owner = await bare();
    const hub = await bare();
    const told: ConversationNotice[] = [];
    const ran: ProcessRun[] = [];
    const onHub = new HubService({ store: memoryHubStore(), invites: { send: async () => ({ link: 'l', emailed: false }) } });
    const sharing = new ProjectSharingService({
      store: db, sharing: localHubSharing(onHub, 'i1'), sync: { once: async () => undefined }, dataKey: 'k'.repeat(32) as never,
      ownerRepo: async () => ({ url: owner }), notify: async (_owner, _scope, notice) => { told.push(notice); },
      groups: localProjectGroups(db), republish: async () => undefined,
    });
    await db.projects.saveProject({ id: 'p1', ownerId: 'ann', name: 'Shop', createdAt: now } as never);
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
    const repos: HubRepoSides = { ends: async () => ({ owner: { url: owner }, hub: { url: hub } }), conflicted: sharing.repoSides().conflicted };
    const lines: string[] = [];
    const sync = new HubSyncService({
      store: db.hub, transport: localHubSync(onHub, 'i1'), origin: 'instance:i1', repos,
      git: { run: (given) => { ran.push(given); return nodeProcesses.run(given); } }, log: (line) => lines.push(line),
    });
    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: 'hub-1', pulledThrough: 0, sharedAt: now, repo: { url: 'http://gitea/p1.git', username: 'bot', tokenEnc: 'sealed' } });
    return { db, owner, hub, sync, told, ran, lines };
  }

  const heads = async (repo: string) => (await run('git', ['-C', repo, 'rev-parse', 'main'])).stdout.trim();

  it('copies main across when only one side has it, remembers both heads, and leaves it alone until a side moves', async () => {
    const { db, owner, hub, sync, ran } = await withRepos();
    const first = await commit(owner, 'a.txt', 'one');
    expect(await sync.syncRepos()).toBe(1);
    expect(await heads(hub)).toBe(first);
    expect((await db.hub.getHubLinks())[0]?.repoHeads).toEqual({ owner: first, hub: first });

    const before = ran.length;
    expect(await sync.syncRepos()).toBe(0);
    expect(ran.length).toBe(before + 2);

    const fromMember = await commit(hub, 'b.txt', 'member');
    expect(await sync.syncRepos()).toBe(1);
    expect(await heads(owner)).toBe(fromMember);
    expect((await db.hub.getHubLinks())[0]?.repoHeads).toEqual({ owner: fromMember, hub: fromMember });
  });

  it('keeps the hub\'s main beside the owner\'s on a conflict, tells the project\'s channel once which files and which branch, and leaves it alone until a side moves', async () => {
    const { db, owner, hub, sync, told, ran } = await withRepos();
    await commit(owner, 'a.txt', 'one');
    await sync.syncRepos();
    const ownerHead = await commit(owner, 'a.txt', 'owner');
    const hubHead = await commit(hub, 'a.txt', 'member');

    expect(await sync.syncRepos()).toBe(0);
    const [saved] = await db.hub.getHubLinks();
    expect(saved?.repoConflict).toMatchObject({ owner: ownerHead, hub: hubHead });
    expect(saved!.repoConflict!.kept).toMatch(/^hub\/main-\d{14}$/);
    expect(told).toEqual([expect.objectContaining({
      kind: 'hub-main-conflict',
      refs: { projectId: 'p1', treeId: 't1' },
      text: expect.stringContaining(`Shop's main and the shared main on the hub changed the same lines (a.txt), so neither was changed. The hub's main is kept as the branch ${saved!.repoConflict!.kept}`) as unknown,
    })]);
    expect([await heads(owner), await heads(hub)]).toEqual([ownerHead, hubHead]);

    const before = ran.length;
    await sync.syncRepos();
    expect(told).toHaveLength(1);
    expect(ran.length).toBe(before + 2);

    const moved = await commit(hub, 'c.txt', 'more');
    await sync.syncRepos();
    expect(told).toHaveLength(2);
    expect((await db.hub.getHubLinks())[0]?.repoConflict).toMatchObject({ hub: moved });
  });

  it('clears an old conflict once both mains are the same commit, and says why a main could not be synced and goes on', async () => {
    const { db, owner, hub, sync, lines } = await withRepos();
    const same = await commit(owner, 'a.txt', 'one');
    await run('git', ['-C', owner, 'push', '--quiet', hub, 'main:main']);
    await db.hub.saveHubLink({ ...(await db.hub.getHubLinks())[0]!, repoConflict: { owner: 'x', hub: 'y', kept: 'hub/main-0' } });
    expect(await sync.syncRepos()).toBe(0);
    const [saved] = await db.hub.getHubLinks();
    expect(saved?.repoHeads).toEqual({ owner: same, hub: same });
    expect(saved).not.toHaveProperty('repoConflict');

    await fs.rm(hub, { recursive: true, force: true });
    await db.hub.saveHubLink({ ...saved!, repoHeads: { owner: 'x', hub: 'y' } });
    expect(await sync.syncRepos()).toBe(0);
    expect(lines).toEqual([expect.stringMatching(/^hub sync: p1's main not synced yet: .*does not appear to be a git repository/) as string]);
  });
});

describe('the line to the hub in the same process', () => {
  it('connects when the sync starts, so members reach the instance, and hangs up when it stops', async () => {
    const db = await testDatabase();
    const relay = new HubRelay();
    const hub = new HubService({ store: memoryHubStore(), invites: { send: async () => ({ link: 'l', emailed: false }) }, relay });
    const sync = new HubSyncService({ store: db.hub, transport: localHubSync(hub, 'i1'), origin: 'instance:i1', work: () => ({}) as never });
    expect(relay.online('i1')).toBe(false);
    await sync.start();
    expect(relay.online('i1')).toBe(true);
    await sync.stop();
    expect(relay.online('i1')).toBe(false);
  });
});

describe('the hub in the same process refusing', () => {
  it('fails each call with the hub\'s own reason and status, so the sync says why and tries again on the next pass', async () => {
    const { hub } = await setUp();
    const transport = localHubSync(hub, 'i1');
    const nowhere = { projectId: 'p9', ownerId: 'ann', hubProjectId: 'not-on-the-hub', pulledThrough: 0, sharedAt: now };
    const refusals: string[] = [];
    for (const asked of [
      () => transport.requests(nowhere),
      () => transport.settle(nowhere, 'q1', { state: 'done' }),
      () => transport.status(nowhere, { releases: [], builds: [], runs: [] } as never),
      () => transport.answer(nowhere, 'call-1', { kind: 'json', status: 200, body: [] }),
    ]) refusals.push(await asked().then(() => 'answered', (err: Error & { status?: number }) => `${err.status} ${err.message}`));
    expect(refusals).toEqual([
      ...Array<string>(3).fill('404 There is no such project, or you are not on it.'),
      '404 That call is no longer waiting.',
    ]);
    expect(() => localHubSync(hub, 'i1').connect({ connected: () => undefined, disconnected: () => undefined, changed: () => undefined, call: () => undefined })).toThrow('This hub relays nothing.');
  });
});
