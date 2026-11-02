import { afterEach, describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { Readable } from 'node:stream';
import { anyOf, matching, objectWith } from '../../platform/lib/test-matchers.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Leaf } from '../../projects/lib/leaves.js';
import { mirrored, removed, saved } from '../testing/instance-writes.js';
import { memoryHubStore } from '../lib/hub-store.js';
import type { HubLink, RecordChange } from '../lib/hub-sync.js';
import type { HubRequest, HubStatus } from '../lib/hub-board.js';
import { CHANGES_PAGE, HubService, type SyncOrigin } from './HubService.js';
import { HubRelay, type RelayCall } from './HubRelay.js';
import type { GitEnd, GitProcesses } from './HubRepoSync.js';
import { HubSyncService, localHubSync, STATUS_EVERY_MS, type HubRepoSides, type HubSyncTransport } from './HubSyncService.js';
import { HubInstanceWork, type HubInstanceWorkDeps, type InstanceCall } from './HubInstanceWork.js';

const ann = { id: 'ann', email: 'ann@example.com' };
const now = '2026-10-21T00:00:00Z';

const leaf = (fields: Partial<Leaf> = {}): Leaf => ({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'pending', createdAt: now, updatedAt: now, ...fields });
const tree = (fields: Record<string, unknown> = {}) => ({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now, ...fields });
const link = (fields: Partial<HubLink> = {}): HubLink => ({ projectId: 'p1', ownerId: 'ann', hubProjectId: 'hub-1', pulledThrough: 0, sharedAt: now, ...fields });
const forProject = (projectId: string) => matches<HubLink>((given) => given.projectId === projectId);
const withId = <T extends { id: string }>(id: string) => matches<T>((given) => given.id === id);
const branch = { id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now };

const syncs: HubSyncService[] = [];
afterEach(() => { for (const sync of syncs.splice(0)) sync.stop(); });
const made = (sync: HubSyncService): HubSyncService => { syncs.push(sync); return sync; };

async function shared() {
  const db = memoryDatabase();
  const store = memoryHubStore();
  const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) } });
  const created = await hub.create(ann, { name: 'Shop', origin: { instanceId: 'combined', projectId: 'p1' } });
  if (!created.ok) throw new Error(created.why);
  const hubId = created.value.project.id;
  const sync = made(new HubSyncService({ store: db.hub, transport: localHubSync(hub, 'combined'), origin: 'instance:combined' }));
  return { db, hub, sync, onHub: store.project(hubId), hubId, store };
}

describe('keeping a shared project\'s board in step with the hub', () => {
  it('sends nothing until a project is shared, then only what belongs to it, never a private chat or another project', async () => {
    const { db, sync, onHub, hubId } = await shared();
    await saved(db, 'trees', tree());
    expect(await db.hub.hubDirty(10)).toEqual([]);

    await db.hub.saveHubLink(link({ hubProjectId: hubId }));
    await saved(db, 'trees', tree());
    await saved(db, 'trees', tree({ id: 't2', name: 'Mine', projectIds: ['p2'] }));
    await saved(db, 'branches', branch);
    await saved(db, 'leaves', leaf());
    await saved(db, 'conversations', { id: 'channel-p1', ownerId: 'ann', kind: 'channel', treeId: 't1', projectId: 'p1', messages: [], createdAt: now, updatedAt: now } as never);
    await saved(db, 'conversations', { id: 'mine', ownerId: 'ann', treeId: 't1', projectId: 'p1', messages: [{ role: 'user', content: 'private', at: now }], createdAt: now, updatedAt: now } as never);
    await db.engine.appendMessage('ann', 'channel-p1', { role: 'user', content: 'hello', at: '2026-10-21T00:00:01Z', author: { kind: 'person', id: 'ann' } });
    await mirrored(db, 'conversations', (await db.engine.getConversation('ann', 'channel-p1'))! as never);

    await sync.once();
    expect(await db.hub.hubDirty(10)).toEqual([]);
    expect((await onHub.records('trees')).map((doc) => doc.id)).toEqual(['t1']);
    expect((await onHub.records('leaves')).map((doc) => [doc.id, doc.status])).toEqual([['l1', 'pending']]);
    expect((await onHub.records('conversations')).map((doc) => [doc.id, (doc.messages as { content: string }[]).map((message) => message.content)])).toEqual([['channel-p1', ['hello']]]);

    await sync.once();
    expect((await onHub.changes(0, 100)).length).toBe(4);
  });

  it('brings a member\'s change down and keeps both when the engine changed another field meanwhile; a deleted story goes on both', async () => {
    const { db, sync, onHub, hubId } = await shared();
    await db.hub.saveHubLink(link({ hubProjectId: hubId }));
    await saved(db, 'trees', tree());
    await saved(db, 'branches', branch);
    await saved(db, 'leaves', leaf());
    await sync.once();

    await onHub.putRecord('leaves', { ...(await onHub.record('leaves', 'l1'))!, priority: 1 });
    await onHub.logChange({ origin: 'person:bo', change: { kind: 'leaves', id: 'l1', patch: { set: { priority: 1 } } }, at: now });
    await saved(db, 'leaves', leaf({ status: 'running' }));

    await sync.once();
    expect(await db.hub.syncedRecord('leaves', 'l1')).toMatchObject({ status: 'running', priority: 1 });
    await sync.once();
    expect(await onHub.record('leaves', 'l1')).toMatchObject({ status: 'running', priority: 1 });
    expect((await db.hub.getHubLinks())[0]!.pulledThrough).toBe((await onHub.changes(0, 100)).at(-1)!.seq);

    await removed(db, 'leaves', 'l1');
    await sync.once();
    expect(await onHub.record('leaves', 'l1')).toBeUndefined();
    expect(await db.hub.hubSnapshot('leaves', 'l1')).toBeUndefined();
  });

  it('brings down a member\'s deletion of a record, and forgets what it last agreed about it', async () => {
    const { db, sync, onHub, hubId } = await shared();
    await db.hub.saveHubLink(link({ hubProjectId: hubId }));
    await saved(db, 'trees', tree());
    await saved(db, 'branches', branch);
    await saved(db, 'leaves', leaf());
    await sync.once();

    await onHub.deleteRecord('leaves', 'l1');
    await onHub.logChange({ origin: 'person:bo', change: { kind: 'leaves', id: 'l1', deleted: true }, at: now });
    await sync.once();
    expect(await db.hub.syncedRecord('leaves', 'l1')).toBeUndefined();
    expect(await db.hub.hubSnapshot('leaves', 'l1')).toBeUndefined();
  });

  it('pulls every page when members changed more than one page holds', async () => {
    const { db, sync, onHub, hubId } = await shared();
    await db.hub.saveHubLink(link({ hubProjectId: hubId }));
    await saved(db, 'trees', tree());
    await saved(db, 'branches', branch);
    await saved(db, 'leaves', leaf());
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
    const { db, onHub, hub, hubId } = await shared();
    let down = true;
    const transport = localHubSync(hub, 'combined');
    const sync = made(new HubSyncService({ store: db.hub, origin: 'instance:combined', transport: { ...transport, push: (to, changes) => (down ? Promise.reject(new Error('unreachable')) : transport.push(to, changes)) } }));
    await db.hub.saveHubLink(link({ hubProjectId: hubId }));
    await saved(db, 'trees', tree());
    await sync.once();
    expect((await db.hub.hubDirty(10)).length).toBe(1);
    down = false;
    await sync.once();
    expect([await db.hub.hubDirty(10), (await onHub.records('trees')).length]).toEqual([[], 1]);
  });

  it('stops sharing on the instance when the project was deleted on the hub', async () => {
    const { db, hub, sync, hubId } = await shared();
    await db.hub.saveHubLink(link({ hubProjectId: hubId }));
    await saved(db, 'trees', tree());
    await sync.once();
    await hub.delete('ann', hubId, 'Shop');
    await saved(db, 'trees', tree({ name: 'Shop again' }));
    await sync.once();
    expect([await db.hub.getHubLinks(), await db.hub.hubSnapshot('trees', 't1'), await db.hub.hubDirty(10)]).toEqual([[], undefined, []]);
  });

  it('asked for a pass while one runs, answers only after a pass that began after it was asked', async () => {
    const { db, onHub, hub, hubId } = await shared();
    const transport = localHubSync(hub, 'combined');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let pulls = 0;
    const sync = made(new HubSyncService({ store: db.hub, origin: 'instance:combined', transport: { ...transport, pull: async (...args) => { pulls += 1; if (pulls === 1) await held; return transport.pull(...args); } } }));
    await db.hub.saveHubLink(link({ hubProjectId: hubId }));
    const first = sync.once();
    await vi.waitFor(() => expect(pulls).toBe(1));
    await saved(db, 'trees', tree());
    const asked = sync.once();
    const alsoAsked = sync.once();
    release();
    await Promise.all([first, asked, alsoAsked]);
    expect((await onHub.records('trees')).length).toBe(1);
    expect(pulls).toBe(2);
  });

  it('still runs the pass that was waiting when the one before it failed, and tells the one that asked first', async () => {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    transport.push.mockResolvedValue({ through: 0 });
    transport.pull.mockResolvedValue({ changes: [], through: 0 });
    await db.hub.saveHubLink(link());
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined' }));
    let fail: (reason: Error) => void = () => undefined;
    transport.pull.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    const first = sync.once().then(() => 'finished', (err: Error) => err.message);
    await vi.waitFor(() => expect(transport.pull).toHaveBeenCalledTimes(1));
    const second = sync.once();
    fail(new Error('pull blew up'));
    expect(await first).toBe('finished');
    await second;
    expect(transport.pull).toHaveBeenCalledTimes(2);
  });
});

describe('what goes to the hub in a pass', () => {
  it('moves a record to the project it now belongs to by taking it off the old one first', async () => {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    transport.push.mockResolvedValue({ through: 1 });
    const first = link();
    const second = link({ projectId: 'p2', hubProjectId: 'hub-2' });
    await db.hub.saveHubLink(first);
    await db.hub.saveHubLink(second);
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined' }));
    await saved(db, 'trees', tree());
    expect(await sync.pushOnce()).toBe(1);
    await saved(db, 'trees', tree({ projectIds: ['p2'] }));
    expect(await sync.pushOnce()).toBe(2);

    expect(transport.push).toHaveBeenLastCalledWith(objectWith({ projectId: 'p2' }), [{ kind: 'trees', id: 't1', patch: anyOf(Object) }]);
    expect(transport.push).toHaveBeenCalledWith(objectWith({ projectId: 'p1' }), [{ kind: 'trees', id: 't1', deleted: true }]);
    expect((await db.hub.hubSnapshot('trees', 't1'))?.projectId).toBe('p2');
    expect(await db.hub.hubDirty(10)).toEqual([]);
  });

  it('sends nothing for a record that is no different from what the hub has', async () => {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    transport.push.mockResolvedValue({ through: 1 });
    await db.hub.saveHubLink(link());
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined' }));
    await saved(db, 'trees', tree());
    await sync.pushOnce();
    await saved(db, 'trees', tree());
    expect(await sync.pushOnce()).toBe(0);
    expect(transport.push).toHaveBeenCalledTimes(1);
    expect(await db.hub.hubDirty(10)).toEqual([]);
  });

  it('forgets what it agreed with a project that is no longer shared, whatever happens to the record', async () => {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    await db.hub.saveHubLink(link());
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined' }));
    await db.hub.saveHubSnapshot('gone', 'trees', { id: 't9', name: 'Old' });
    await saved(db, 'trees', tree({ id: 't9', projectIds: [] }));
    expect(await sync.pushOnce()).toBe(0);
    expect(await db.hub.hubSnapshot('trees', 't9')).toBeUndefined();
    expect(await db.hub.hubDirty(10)).toEqual([]);
    expect(transport.push).not.toHaveBeenCalled();
  });

  it('keeps a change and says so when the hub does not take it yet', async () => {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    transport.push.mockRejectedValue(new Error('unreachable'));
    const lines: string[] = [];
    await db.hub.saveHubLink(link());
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined', log: (line) => lines.push(line) }));
    await saved(db, 'trees', tree());
    expect(await sync.pushOnce()).toBe(0);
    expect(lines).toEqual(['hub sync: p1 not sent yet: unreachable']);
    expect((await db.hub.hubDirty(10)).map((entry) => entry.id)).toEqual(['t1']);
    expect(await db.hub.hubSnapshot('trees', 't1')).toBeUndefined();
  });

  it('stops sharing a project the hub no longer knows, and drops what was waiting for it', async () => {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    transport.push.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const lines: string[] = [];
    await db.hub.saveHubLink(link());
    await db.hub.saveHubSnapshot('p1', 'trees', { id: 'old' });
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined', log: (line) => lines.push(line) }));
    await saved(db, 'trees', tree());
    await sync.pushOnce();
    expect(lines).toEqual(['hub sync: p1 is no longer on the hub, so it is no longer shared']);
    expect([await db.hub.getHubLinks(), await db.hub.hubSnapshot('trees', 'old'), await db.hub.hubDirty(10)]).toEqual([[], undefined, []]);
  });
});

describe('what comes back from the hub in a pass', () => {
  it('leaves out the changes this instance made itself', async () => {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    transport.pull.mockResolvedValue({
      changes: [
        { seq: 1, origin: 'instance:combined', change: { kind: 'trees', id: 't1', patch: { set: { name: 'mine' } } }, at: now },
        { seq: 2, origin: 'person:bo', change: { kind: 'trees', id: 't1', patch: { set: { name: 'bo' } } }, at: now },
      ],
      through: 2,
    });
    await db.hub.saveHubLink(link());
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined' }));
    expect(await sync.pullOnce()).toBe(1);
    expect(await db.hub.syncedRecord('trees', 't1')).toMatchObject({ name: 'bo' });
    expect((await db.hub.getHubLinks())[0]?.pulledThrough).toBe(2);
  });

  it('keeps who is on the project as the hub names them, and only saves the link again when something moved', async () => {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    const members = [{ personId: 'ann', email: 'ann@example.com', role: 'owner' }];
    transport.pull.mockResolvedValue({ changes: [], through: 0, members });
    await db.hub.saveHubLink(link());
    const save = vi.spyOn(db.hub, 'saveHubLink');
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined' }));
    await sync.pullOnce();
    expect((await db.hub.getHubLinks())[0]?.members).toEqual(members);
    await sync.pullOnce();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('says why a project could not be read and goes on to the next', async () => {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    transport.pull.calledWith(forProject('p1'), 0).mockRejectedValue(new Error('hub down'));
    transport.pull.calledWith(forProject('p2'), 0).mockResolvedValue({ changes: [{ seq: 1, origin: 'person:bo', change: { kind: 'trees', id: 't2', patch: { set: { name: 'bo' } } }, at: now }], through: 1 });
    const lines: string[] = [];
    await db.hub.saveHubLink(link());
    await db.hub.saveHubLink(link({ projectId: 'p2', hubProjectId: 'hub-2' }));
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined', log: (line) => lines.push(line) }));
    expect(await sync.pullOnce()).toBe(1);
    expect(lines).toEqual(['hub sync: p1 not read yet: hub down']);
  });

  it('stops sharing a project the hub says is gone', async () => {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    transport.pull.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    await db.hub.saveHubLink(link());
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined' }));
    expect(await sync.pullOnce()).toBe(0);
    expect(await db.hub.getHubLinks()).toEqual([]);
  });
});

describe('keeping main in step with the hub\'s', () => {
  const OWNER_HEAD = 'a'.repeat(40);
  const HUB_HEAD = 'b'.repeat(40);
  const ends: { owner: GitEnd; hub: GitEnd } = { owner: { url: 'https://git.example/owner.git' }, hub: { url: 'https://git.example/hub.git', auth: { username: 'bot', token: 'secret' } } };
  const said = (...words: string[]) => matches<Parameters<GitProcesses['run']>[0]>((run) => run.args.join(' ').includes(words.join(' ')));
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

  function remotes(heads: { owner?: string; hub?: string }, scripted: [ReturnType<typeof said>, ReturnType<typeof ok>][] = []) {
    const git = mock<GitProcesses>();
    git.run.calledWith(matches(() => true)).mockResolvedValue(ok());
    git.run.calledWith(said('ls-remote', ends.owner.url)).mockResolvedValue(ok(heads.owner ? `${heads.owner}\trefs/heads/main\n` : ''));
    git.run.calledWith(said('ls-remote', ends.hub.url)).mockResolvedValue(ok(heads.hub ? `${heads.hub}\trefs/heads/main\n` : ''));
    for (const [asked, answer] of scripted) git.run.calledWith(asked).mockResolvedValue(answer);
    return git;
  }

  function setUp(git: GitProcesses, sides: HubRepoSides | undefined = mock<HubRepoSides>({ ends: async () => ends })) {
    const db = memoryDatabase();
    const lines: string[] = [];
    const sync = made(new HubSyncService({ store: db.hub, transport: mock<HubSyncTransport>(), origin: 'instance:combined', repos: sides, git, log: (line) => lines.push(line) }));
    return { db, sync, lines, sides };
  }

  const repo = { url: 'https://git.example/p1.git', username: 'bot', tokenEnc: 'sealed' };

  it('does nothing without repositories to compare', async () => {
    const { sync, db } = setUp(remotes({}), undefined);
    await db.hub.saveHubLink(link({ repo }));
    expect(await sync.syncRepos()).toBe(0);
  });

  it('skips a project that keeps no repository on the hub, and one whose ends cannot be found', async () => {
    const sides = mock<HubRepoSides>();
    sides.ends.mockResolvedValue(undefined);
    const git = remotes({});
    const { sync, db } = setUp(git, sides);
    await db.hub.saveHubLink(link());
    await db.hub.saveHubLink(link({ projectId: 'p2', hubProjectId: 'hub-2', repo }));
    expect(await sync.syncRepos()).toBe(0);
    expect(sides.ends).toHaveBeenCalledTimes(1);
    expect(git.run).not.toHaveBeenCalled();
  });

  it('copies main across when only one side has it, and remembers both heads', async () => {
    const git = remotes({ owner: OWNER_HEAD });
    const { sync, db } = setUp(git);
    await db.hub.saveHubLink(link({ repo }));
    expect(await sync.syncRepos()).toBe(1);
    expect((await db.hub.getHubLinks())[0]?.repoHeads).toEqual({ owner: OWNER_HEAD, hub: OWNER_HEAD });
  });

  it('does not touch main again while neither side has moved', async () => {
    const git = remotes({ owner: OWNER_HEAD, hub: HUB_HEAD });
    const { sync, db } = setUp(git);
    await db.hub.saveHubLink(link({ repo, repoHeads: { owner: OWNER_HEAD, hub: HUB_HEAD } }));
    expect(await sync.syncRepos()).toBe(0);
    expect(git.run).toHaveBeenCalledTimes(2);
  });

  it('counts nothing when both were already the same commit, and clears an old conflict', async () => {
    const git = remotes({ owner: OWNER_HEAD, hub: OWNER_HEAD });
    const { sync, db } = setUp(git);
    await db.hub.saveHubLink(link({ repo, repoConflict: { owner: 'x', hub: 'y', kept: 'hub/main-0' } }));
    expect(await sync.syncRepos()).toBe(0);
    const [saved] = await db.hub.getHubLinks();
    expect(saved?.repoHeads).toEqual({ owner: OWNER_HEAD, hub: OWNER_HEAD });
    expect(saved).not.toHaveProperty('repoConflict');
  });

  it('keeps the hub\'s main beside the owner\'s on a conflict, tells the project once, and leaves it alone until a side moves', async () => {
    const git = remotes({ owner: OWNER_HEAD, hub: HUB_HEAD }, [
      [said('merge-base --is-ancestor'), { code: 1, stdout: '', stderr: '' }],
      [said('merge --quiet --no-edit'), { code: 1, stdout: '', stderr: '' }],
      [said('diff --name-only --diff-filter=U'), ok('a.txt\n')],
    ]);
    const { sync, db, sides } = setUp(git);
    await db.hub.saveHubLink(link({ repo }));
    expect(await sync.syncRepos()).toBe(0);
    const [saved] = await db.hub.getHubLinks();
    expect(saved?.repoConflict).toEqual({ owner: OWNER_HEAD, hub: HUB_HEAD, kept: anyOf(String) });
    expect(sides?.conflicted).toHaveBeenCalledWith(objectWith({ projectId: 'p1' }), { files: ['a.txt'], kept: matching(/^hub\/main-\d{14}$/) });
    const calls = git.run.mock.calls.length;
    await sync.syncRepos();
    expect(sides?.conflicted).toHaveBeenCalledTimes(1);
    expect(git.run.mock.calls.length).toBe(calls + 2);
  });

  it('says why main could not be synced and goes on', async () => {
    const git = mock<GitProcesses>();
    git.run.mockResolvedValue({ code: 128, stdout: '', stderr: 'fatal: no route' });
    const { sync, db, lines } = setUp(git);
    await db.hub.saveHubLink(link({ repo }));
    expect(await sync.syncRepos()).toBe(0);
    expect(lines).toEqual(['hub sync: p1\'s main not synced yet: fatal: no route']);
  });

  it('forgets a project that was unshared while its main was being synced', async () => {
    const git = remotes({ owner: OWNER_HEAD });
    const { sync, db } = setUp(git);
    await db.hub.saveHubLink(link({ repo }));
    const sides = mock<HubRepoSides>();
    sides.ends.mockImplementation(async (given) => {
      await db.hub.deleteHubLink(given.projectId);
      return ends;
    });
    const unshared = made(new HubSyncService({ store: db.hub, transport: mock<HubSyncTransport>(), origin: 'instance:combined', repos: sides, git }));
    expect(await unshared.syncRepos()).toBe(0);
    expect(await sync.syncRepos()).toBe(0);
    expect(await db.hub.getHubLinks()).toEqual([]);
  });
});

describe('carrying out what members asked for', () => {
  const request = (fields: Partial<HubRequest> = {}): HubRequest => ({ id: 'r1', kind: 'approve-plan', input: { proposalId: 'x' }, by: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, at: now, after: 0, state: 'waiting', ...fields });

  async function setUp() {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    const work = mock<HubInstanceWork>();
    const lines: string[] = [];
    await db.hub.saveHubLink(link({ pulledThrough: 5 }));
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined', work: () => work, log: (line) => lines.push(line) }));
    return { db, transport, work, sync, lines };
  }

  it('does nothing without an instance to do it', async () => {
    const db = memoryDatabase();
    await db.hub.saveHubLink(link());
    const transport = mock<HubSyncTransport>();
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined' }));
    expect([await sync.carryOutRequests(), await sync.sendStatus()]).toEqual([0, 0]);
    expect(transport.requests).not.toHaveBeenCalled();
  });

  it('settles a request as done once it is carried out, and as refused with the reason when it is not', async () => {
    const { transport, work, sync } = await setUp();
    transport.requests.mockResolvedValue([request(), request({ id: 'r2', kind: 'reject-plan' })]);
    work.carryOut.calledWith(forProject('p1'), withId<HubRequest>('r1')).mockResolvedValue({ ok: true });
    work.carryOut.calledWith(forProject('p1'), withId<HubRequest>('r2')).mockResolvedValue({ ok: false, why: 'not part of it' });
    expect(await sync.carryOutRequests()).toBe(2);
    expect(transport.settle).toHaveBeenCalledWith(objectWith({ projectId: 'p1' }), 'r1', { state: 'done' });
    expect(transport.settle).toHaveBeenCalledWith(objectWith({ projectId: 'p1' }), 'r2', { state: 'refused', why: 'not part of it' });
  });

  it('refuses a request whose carrying out failed, with what went wrong', async () => {
    const { transport, work, sync } = await setUp();
    transport.requests.mockResolvedValue([request()]);
    work.carryOut.mockRejectedValue(new Error('engine down'));
    await sync.carryOutRequests();
    expect(transport.settle).toHaveBeenCalledWith(objectWith({ projectId: 'p1' }), 'r1', { state: 'refused', why: 'engine down' });
  });

  it('waits for a request whose messages have not arrived yet', async () => {
    const { transport, work, sync } = await setUp();
    transport.requests.mockResolvedValue([request({ after: 9 })]);
    expect(await sync.carryOutRequests()).toBe(0);
    expect(work.carryOut).not.toHaveBeenCalled();
  });

  it('says so when the hub cannot be asked, or a request could not be settled', async () => {
    const { transport, work, sync, lines, db } = await setUp();
    transport.requests.mockRejectedValueOnce(new Error('hub down'));
    expect(await sync.carryOutRequests()).toBe(0);
    transport.requests.mockResolvedValue([request()]);
    work.carryOut.mockResolvedValue({ ok: true });
    transport.settle.mockRejectedValue(new Error('hub down again'));
    expect(await sync.carryOutRequests()).toBe(0);
    expect(lines).toEqual([
      'hub sync: p1\'s requests not read yet: hub down',
      'hub sync: p1\'s request r1 was carried out but not settled yet: hub down again',
    ]);
    expect((await db.hub.getHubLinks()).length).toBe(1);
  });
});

describe('telling the hub what is live', () => {
  const status = (fields: Partial<HubStatus> = {}): HubStatus => ({ at: '1', releases: [], runs: [], treeRuns: {}, ...fields });

  async function setUp() {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    const work = mock<HubInstanceWork>();
    const lines: string[] = [];
    await db.hub.saveHubLink(link());
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined', work: () => work, log: (line) => lines.push(line) }));
    return { db, transport, work, sync, lines };
  }

  it('sends it once, and not again while only its time has changed', async () => {
    const { transport, work, sync } = await setUp();
    work.statusOf.mockResolvedValueOnce(status({ at: '1' })).mockResolvedValue(status({ at: '2' }));
    expect(await sync.sendStatus()).toBe(1);
    vi.useFakeTimers({ now: Date.now() + STATUS_EVERY_MS + 1 });
    try {
      expect(await sync.sendStatus()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(transport.status).toHaveBeenCalledTimes(1);
  });

  it('sends it again when something in it changed, once its turn has come', async () => {
    const { transport, work, sync } = await setUp();
    work.statusOf.mockResolvedValueOnce(status()).mockResolvedValue(status({ releases: [{ id: 'r1' }] }));
    await sync.sendStatus();
    vi.useFakeTimers({ now: Date.now() + STATUS_EVERY_MS + 1 });
    try {
      expect(await sync.sendStatus()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    expect(transport.status).toHaveBeenCalledTimes(2);
  });

  it('waits its turn when nothing was sent to the hub since', async () => {
    const { work, sync } = await setUp();
    work.statusOf.mockResolvedValueOnce(status()).mockResolvedValue(status({ releases: [{ id: 'r1' }] }));
    await sync.sendStatus();
    expect(await sync.sendStatus()).toBe(0);
    expect(work.statusOf).toHaveBeenCalledTimes(1);
  });

  it('looks at once after changes went up to the hub', async () => {
    const { db, transport, work, sync } = await setUp();
    transport.push.mockResolvedValue({ through: 1 });
    transport.pull.mockResolvedValue({ changes: [], through: 0 });
    transport.requests.mockResolvedValue([]);
    work.statusOf.mockResolvedValueOnce(status()).mockResolvedValue(status({ releases: [{ id: 'r1' }] }));
    await sync.sendStatus();
    await saved(db, 'trees', tree());
    await sync.pushOnce();
    expect(await sync.sendStatus()).toBe(1);
  });

  it('sends nothing for a project the instance no longer has', async () => {
    const { transport, work, sync } = await setUp();
    work.statusOf.mockResolvedValue(undefined);
    expect(await sync.sendStatus()).toBe(0);
    expect(transport.status).not.toHaveBeenCalled();
  });

  it('says so when the hub does not take it, and sends it again next time', async () => {
    const { transport, work, sync, lines } = await setUp();
    work.statusOf.mockResolvedValue(status());
    transport.status.mockRejectedValueOnce(new Error('hub down'));
    expect(await sync.sendStatus()).toBe(0);
    expect(lines).toEqual(['hub sync: p1\'s status not sent yet: hub down']);
    vi.useFakeTimers({ now: Date.now() + STATUS_EVERY_MS + 1 });
    try {
      expect(await sync.sendStatus()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('answering what the hub asks of the owner\'s instance', () => {
  const call = (fields: Partial<InstanceCall> = {}): InstanceCall => ({ id: 'c1', op: 'extensions', args: {}, as: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, ...fields });

  async function setUp(retryMs = 5) {
    const db = memoryDatabase();
    const transport = mock<HubSyncTransport>();
    const work = mock<HubInstanceWork>();
    transport.answer.mockResolvedValue(undefined);
    const lines: string[] = [];
    await db.hub.saveHubLink(link());
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined', work: () => work, retryMs, log: (line) => lines.push(line) }));
    const idle = () => transport.take.mockImplementation((_to, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve(undefined), { once: true }); }));
    return { db, transport, work, sync, lines, idle };
  }

  it('does not listen without an instance to answer', async () => {
    const db = memoryDatabase();
    await db.hub.saveHubLink(link());
    const transport = mock<HubSyncTransport>();
    const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined' }));
    await sync.followRelays();
    expect(transport.take).not.toHaveBeenCalled();
  });

  it('takes a call the hub hands over, has the instance answer it, and gives the answer back', async () => {
    const { transport, work, sync, idle } = await setUp();
    const answer = { kind: 'json' as const, status: 200, body: [] };
    transport.take.mockResolvedValueOnce(call());
    idle();
    work.handle.calledWith(forProject('p1'), withId<InstanceCall>('c1')).mockResolvedValue(answer);
    await sync.followRelays();
    await vi.waitFor(() => expect(transport.answer).toHaveBeenCalledWith(objectWith({ projectId: 'p1' }), 'c1', answer));
  });

  it('answers a call the instance could not handle with what went wrong, as a bad gateway', async () => {
    const { transport, work, sync, idle } = await setUp();
    transport.take.mockResolvedValueOnce(call());
    idle();
    work.handle.mockRejectedValue(new Error('files are down'));
    await sync.followRelays();
    await vi.waitFor(() => expect(transport.answer).toHaveBeenCalledWith(objectWith({ projectId: 'p1' }), 'c1', { kind: 'json', status: 502, body: { error: 'The owner\'s instance could not answer: files are down' } }));
  });

  it('says so when the hub does not take the answer', async () => {
    const { transport, work, sync, lines, idle } = await setUp();
    transport.take.mockResolvedValueOnce(call());
    idle();
    work.handle.mockResolvedValue({ kind: 'json', status: 200, body: null });
    transport.answer.mockRejectedValue(new Error('hub down'));
    await sync.followRelays();
    await vi.waitFor(() => expect(lines).toEqual(['hub sync: an answer to the hub was lost: hub down']));
  });

  it('tries again after a pause when the hub cannot be listened to', async () => {
    const { transport, sync, lines, idle } = await setUp(1);
    transport.take.mockRejectedValueOnce(new Error('hub down'));
    idle();
    await sync.followRelays();
    await vi.waitFor(() => expect(transport.take).toHaveBeenCalledTimes(2));
    expect(lines).toEqual(['hub sync: p1 is not taking the hub\'s calls yet: hub down']);
  });

  it('listens once per project however often it is asked, and stops for a project no longer shared', async () => {
    const { db, transport, sync, idle } = await setUp();
    idle();
    await sync.followRelays();
    await sync.followRelays();
    await vi.waitFor(() => expect(transport.take).toHaveBeenCalledTimes(1));
    const signal = transport.take.mock.calls[0]![1];
    await db.hub.deleteHubLink('p1');
    await sync.followRelays();
    expect(signal.aborted).toBe(true);
  });

  it('stops listening when told to stop', async () => {
    const { transport, sync, idle } = await setUp();
    idle();
    await sync.followRelays();
    await vi.waitFor(() => expect(transport.take).toHaveBeenCalledTimes(1));
    const signal = transport.take.mock.calls[0]![1];
    sync.stop();
    expect(signal.aborted).toBe(true);
  });
});

describe('running on a timer', () => {
  it('runs a pass on every beat, says when one fails, and stops when told to', async () => {
    vi.useFakeTimers();
    try {
      const db = memoryDatabase();
      const transport = mock<HubSyncTransport>();
      transport.pull.mockRejectedValue(new Error('hub down'));
      await db.hub.saveHubLink(link());
      const lines: string[] = [];
      const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined', log: (line) => lines.push(line) }));
      sync.start(1_000);
      sync.start(1_000);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(transport.pull).toHaveBeenCalledTimes(2);
      sync.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(transport.pull).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a pass that fails outright', async () => {
    vi.useFakeTimers();
    try {
      const db = memoryDatabase();
      const transport = mock<HubSyncTransport>();
      const lines: string[] = [];
      vi.spyOn(db.hub, 'hubDirty').mockRejectedValue(new Error('database down'));
      const sync = made(new HubSyncService({ store: db.hub, transport, origin: 'instance:combined', log: (line) => lines.push(line) }));
      sync.start(1_000);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(lines).toEqual(['hub sync: database down']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the hub in the same process', () => {
  type LocalHub = Parameters<typeof localHubSync>[0];
  const outcomeOf = <T>(value: T) => ({ ok: true as const, value });
  const refusal = { ok: false as const, status: 403 as const, why: 'no' };
  const theLink = link({ hubProjectId: 'hub-1' });
  const origin = matches<SyncOrigin>((given) => given.kind === 'instance' && given.personId === 'ann' && given.instanceId === 'inst');

  it('asks as the instance of the project\'s owner, and hands back what the hub answered', async () => {
    const hub = mock<LocalHub>();
    const waiting: HubRequest[] = [];
    hub.waitingRequests.calledWith(origin, 'hub-1').mockResolvedValue(outcomeOf(waiting));
    hub.settleRequest.calledWith(origin, 'hub-1', 'r1', matches<{ state: unknown }>((given) => given.state === 'done')).mockResolvedValue(outcomeOf({} as HubRequest));
    hub.putStatus.calledWith(origin, 'hub-1', matches(() => true)).mockResolvedValue(outcomeOf({ at: '1' }));
    hub.answerRelay.calledWith(origin, 'c1', matches(() => true)).mockResolvedValue(outcomeOf({ answered: 'c1' }));
    hub.receive.calledWith(origin, 'hub-1', matches(() => true)).mockResolvedValue(outcomeOf({ through: 3 }));
    hub.changesSince.calledWith(origin, 'hub-1', 2).mockResolvedValue(outcomeOf({ changes: [], through: 2, members: [] }));
    const transport = localHubSync(hub, 'inst');
    expect(await transport.requests(theLink)).toBe(waiting);
    await transport.settle(theLink, 'r1', { state: 'done' });
    await transport.status(theLink, { at: '1', releases: [], runs: [], treeRuns: {} });
    await transport.answer(theLink, 'c1', { kind: 'json', status: 200, body: null });
    const changes: RecordChange[] = [{ kind: 'trees', id: 't1', deleted: true }];
    expect(await transport.push(theLink, changes)).toEqual({ through: 3 });
    expect(await transport.pull(theLink, 2)).toEqual({ changes: [], through: 2, members: [] });
  });

  it('throws the hub\'s refusal with its status, for every call it makes', async () => {
    const hub = mock<LocalHub>();
    hub.waitingRequests.mockResolvedValue(refusal);
    hub.settleRequest.mockResolvedValue(refusal);
    hub.putStatus.mockResolvedValue(refusal);
    hub.takeRelay.mockResolvedValue(refusal);
    hub.answerRelay.mockResolvedValue(refusal);
    hub.receive.mockResolvedValue(refusal);
    hub.changesSince.mockResolvedValue(refusal);
    const transport = localHubSync(hub, 'inst');
    const status = { at: '1', releases: [], runs: [], treeRuns: {} };
    const attempts = [
      transport.requests(theLink),
      transport.settle(theLink, 'r1', { state: 'done' }),
      transport.status(theLink, status),
      transport.take(theLink, new AbortController().signal),
      transport.answer(theLink, 'c1', { kind: 'json', status: 200, body: null }),
      transport.push(theLink, []),
      transport.pull(theLink, 0),
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toMatchObject({ message: 'no', status: 403 });
  });

  it('hands over nothing when the hub has no call waiting, and a call with a stream it can be uploaded from', async () => {
    const hub = mock<LocalHub>();
    const stream = Readable.from(['bytes']);
    const waiting: RelayCall = { id: 'c1', projectId: 'p', op: 'files.upload', args: { path: 'a' }, as: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, upload: { stream, type: 'text/plain', size: 5 } };
    hub.takeRelay.mockResolvedValueOnce(outcomeOf(undefined)).mockResolvedValueOnce(outcomeOf(waiting)).mockResolvedValueOnce(outcomeOf({ ...waiting, upload: { stream, type: 'text/plain' } })).mockResolvedValueOnce(outcomeOf({ ...waiting, upload: undefined }));
    const transport = localHubSync(hub, 'inst');
    const signal = new AbortController().signal;
    expect(await transport.take(theLink, signal)).toBeUndefined();
    const withSize = await transport.take(theLink, signal);
    expect(withSize).toMatchObject({ id: 'c1', op: 'files.upload', upload: { type: 'text/plain', size: 5 } });
    expect(await withSize?.upload?.open()).toBe(stream);
    const withoutSize = await transport.take(theLink, signal);
    expect(withoutSize?.upload).not.toHaveProperty('size');
    expect(await transport.take(theLink, signal)).not.toHaveProperty('upload');
  });

  it('tells the hub the listening is over when it is stopped, or was already', async () => {
    const hub = mock<LocalHub>();
    const closing: Promise<void>[] = [];
    hub.takeRelay.mockImplementation(async (_origin, _id, closed) => { closing.push(closed); return outcomeOf(undefined); });
    const transport = localHubSync(hub, 'inst');
    const controller = new AbortController();
    await transport.take(theLink, controller.signal);
    let closedYet = false;
    void closing[0]!.then(() => { closedYet = true; });
    await Promise.resolve();
    expect(closedYet).toBe(false);
    controller.abort();
    await closing[0];
    expect(closedYet).toBe(true);
    await transport.take(theLink, controller.signal);
    await closing[1];
  });
});

describe('members working a shared project from the hub', () => {
  async function working() {
    const db = memoryDatabase();
    const store = memoryHubStore();
    const relay = new HubRelay(Date.now, 60_000);
    const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) }, relay });
    const created = await hub.create(ann, { name: 'Shop', origin: { instanceId: 'combined', projectId: 'p1' } });
    if (!created.ok) throw new Error(created.why);
    const hubId = created.value.project.id;
    for (const [personId, role] of [['cy', 'client'], ['bo', 'collaborator']] as const) {
      await store.project(hubId).saveMember({ personId, email: `${personId}@example.com`, role, joinedAt: now });
      await store.addMembership(personId, hubId);
    }
    const act = mock<HubInstanceWorkDeps['act']>();
    const ok = { ok: true as const };
    act.approvePlan.mockResolvedValue(ok);
    act.rejectPlan.mockResolvedValue(ok);
    act.orderStories.mockResolvedValue(ok);
    act.orderFeatures.mockResolvedValue(ok);
    act.decideTask.mockResolvedValue(ok);
    act.askKoala.mockResolvedValue(ok);
    act.openChat.mockResolvedValue(ok);
    const status = vi.fn<HubInstanceWorkDeps['status']>(async (ownerId, project, treeIds) => ({ at: 'now', releases: [{ id: 'r1', state: 'live', commit: 'abc', startedAt: '1' }], runs: [], treeRuns: Object.fromEntries(treeIds.map((id) => [id, { state: 'idle' }])), addresses: { owner: ownerId, project: project.id } }));
    const work = new HubInstanceWork({ store: db, status, act, live: mock<HubInstanceWorkDeps['live']>(), files: mock<HubInstanceWorkDeps['files']>() });
    const sync = made(new HubSyncService({ store: db.hub, transport: localHubSync(hub, 'combined'), origin: 'instance:combined', work: () => work, retryMs: 10 }));
    await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: 'ann', createdAt: now } as never);
    await db.hub.saveHubLink(link({ hubProjectId: hubId }));
    await saved(db, 'trees', tree());
    await saved(db, 'branches', branch);
    await saved(db, 'leaves', leaf());
    await saved(db, 'leaves', leaf({ id: 'l2', title: 'Refund' }));
    await saved(db, 'conversations', { id: 'channel-p1', ownerId: 'ann', kind: 'channel', treeId: 't1', projectId: 'p1', messages: [], createdAt: now, updatedAt: now } as never);
    await sync.once();
    await vi.waitFor(() => expect(relay.online(hubId)).toBe(true));
    return { db, hub, hubId, sync, act, relay, store, status };
  }

  it('brings a client\'s question to Koala on the owner\'s instance once the message itself has arrived, naming who asked', async () => {
    const { db, hub, hubId, sync, act, relay } = await working();
    const posted = await hub.post({ id: 'cy', email: 'cy@example.com' }, hubId, 'channel-p1', { content: 'can the button be green?', askKoala: true });
    if (!posted.ok) throw new Error(posted.why);
    expect(posted.value.asked?.state).toBe('waiting');
    await sync.once();
    const message = ((await db.hub.syncedRecord('conversations', 'channel-p1'))!.messages as { content: string; author?: unknown }[]).find((entry) => entry.content === 'can the button be green?');
    expect(message?.author).toEqual({ kind: 'person', id: 'cy' });
    expect(act.askKoala).toHaveBeenCalledTimes(1);
    expect(act.askKoala).toHaveBeenCalledWith('ann', objectWith({ id: 'channel-p1' }), { at: posted.value.message.at, content: 'can the button be green?' }, { personId: 'cy', email: 'cy@example.com', role: 'client', projectId: 'p1', hubProjectId: hubId });
    expect((await db.hub.getHubLinks())[0]!.members?.map((member) => member.email).sort()).toEqual(['ann@example.com', 'bo@example.com', 'cy@example.com']);
    const board = await hub.boardView('cy', hubId);
    expect(board.ok && board.value.requests.map((request) => request.state)).toEqual(['done']);
    relay.stop();
  });

  it('posts a collaborator\'s message without asking Koala, which answers them from their own instance', async () => {
    const { hub, hubId, sync, act, relay } = await working();
    const posted = await hub.post({ id: 'bo', email: 'bo@example.com' }, hubId, 'channel-p1', { content: '@koala what is left?' });
    expect(posted.ok && [posted.value.asked, posted.value.notAsked !== undefined]).toEqual([undefined, true]);
    await sync.once();
    expect(act.askKoala).not.toHaveBeenCalled();
    relay.stop();
  });

  it('carries out a collaborator\'s new order of stories as the owner, refuses a client\'s, and refuses one the instance does not know', async () => {
    const { hub, hubId, sync, act, relay, store } = await working();
    expect((await hub.request({ id: 'bo', email: 'bo@example.com' }, hubId, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'] })).ok).toBe(true);
    expect(await hub.request({ id: 'cy', email: 'cy@example.com' }, hubId, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'] })).toMatchObject({ ok: false, status: 403 });
    await store.project(hubId).saveRequest({ id: 'forged', kind: 'accept-task', input: { taskId: 'not-here' }, by: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, at: now, after: 0, state: 'waiting' });
    await sync.once();
    expect(act.orderStories).toHaveBeenCalledTimes(1);
    expect(act.orderStories).toHaveBeenCalledWith('ann', 'b1', ['l2', 'l1']);
    expect(act.decideTask).not.toHaveBeenCalled();
    const settled = await store.project(hubId).requests();
    expect(settled.map((request) => [request.kind, request.state]).sort()).toEqual([['accept-task', 'refused'], ['order-stories', 'done']]);
    relay.stop();
  });

  it('carries out a member\'s removal on the owner\'s instance as a revocation of that shared project, and takes it from nobody but the hub', async () => {
    const { hub, hubId, sync, act, relay, store } = await working();
    expect(await hub.request({ id: 'bo', email: 'bo@example.com' }, hubId, { kind: 'member-removed', personId: 'cy' })).toMatchObject({ ok: false, status: 400 });
    expect((await hub.remove('ann', hubId, 'cy')).ok).toBe(true);
    await store.project(hubId).saveRequest({ id: 'forged', kind: 'member-removed', input: { personId: 'ann' }, by: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, at: now, after: 0, state: 'waiting' });
    await sync.once();
    expect(act.memberRemoved).toHaveBeenCalledTimes(1);
    expect(act.memberRemoved).toHaveBeenCalledWith({ personId: 'cy', because: 'removed-from-shared-project', at: anyOf(String), sharedProjectId: hubId });
    const settled = await store.project(hubId).requests();
    expect(settled.map((request) => [request.id === 'forged' ? 'forged' : request.kind, request.state]).sort()).toEqual([['forged', 'refused'], ['member-removed', 'done']]);
    relay.stop();
  });

  it('sends what is live once, shows a client all of it, and nothing again until it changes', async () => {
    const { hub, hubId, sync, relay, store, status } = await working();
    const first = await store.project(hubId).status();
    expect(first?.treeRuns).toEqual({ t1: { state: 'idle' } });
    await sync.once();
    expect((await store.project(hubId).status())?.at).toBe(first?.at);
    expect(status).toHaveBeenCalledTimes(1);
    const seen = await hub.boardView('cy', hubId);
    expect(seen.ok && seen.value.board.status).toEqual({ at: first!.at, releases: [{ id: 'r1', state: 'live', commit: 'abc', startedAt: '1' }], runs: [], treeRuns: { t1: { state: 'idle' } }, addresses: { owner: 'ann', project: 'p1' } });
    relay.stop();
  });
});
