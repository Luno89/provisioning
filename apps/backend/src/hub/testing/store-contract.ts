import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from '../../engine/index.js';
import type { HubLink } from '../lib/hub-sync.js';
import type { HubStore } from '../store.js';

const link = (projectId: string, extra: Partial<HubLink> = {}): HubLink => ({
  projectId,
  ownerId: 'owner-1',
  hubProjectId: `hub-${projectId}`,
  pulledThrough: 0,
  sharedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

const message = (at: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({ role: 'user', content: `said at ${at}`, at, author: { kind: 'person', id: 'ann' }, ...extra });

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3));

export function hubStoreContract(make: () => Promise<HubStore>): void {
  describe('projects shared to the hub', () => {
    it('keeps a link as it was saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      expect(await store.getHubLinks()).toEqual([]);
      const full = link('p1', {
        group: 'shop',
        repo: { url: 'https://git.example/p1.git', username: 'bot', tokenEnc: 'sealed' },
        repoHeads: { owner: 'aaa', hub: 'bbb' },
        repoConflict: { owner: 'aaa', kept: 'hub/main-1' },
        members: [{ personId: 'm1', email: 'm1@example.com', role: 'client' }],
      });
      await store.saveHubLink(full);
      await store.saveHubLink(link('p2'));
      expect(await store.getHubLinks()).toEqual([full, link('p2')]);
      await store.saveHubLink(link('p1', { pulledThrough: 7 }));
      const replaced = (await store.getHubLinks()).find((stored) => stored.projectId === 'p1');
      expect(replaced).toEqual(link('p1', { pulledThrough: 7 }));
      expect(replaced).not.toHaveProperty('group');
      await store.deleteHubLink('p1');
      await store.deleteHubLink('never');
      expect((await store.getHubLinks()).map((stored) => stored.projectId)).toEqual(['p2']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveHubLink(link('p1', { members: [{ personId: 'm1', email: 'm1@example.com', role: 'client' }] }));
      const [read] = await store.getHubLinks();
      read!.pulledThrough = 99;
      read!.members![0]!.role = 'owner';
      const [again] = await store.getHubLinks();
      expect(again?.pulledThrough).toBe(0);
      expect(again?.members?.[0]?.role).toBe('client');
    });
  });

  describe('records waiting to be sent to the hub', () => {
    it('marks nothing while no project is shared', async () => {
      const store = await make();
      await store.markForHub('trees', 't1', false);
      expect(await store.hubDirty(10)).toEqual([]);
      await store.saveHubLink(link('p1'));
      expect(await store.hubDirty(10)).toEqual([]);
    });

    it('lists what was marked oldest first, up to the limit', async () => {
      const store = await make();
      await store.saveHubLink(link('p1'));
      await store.markForHub('trees', 't1', false);
      await pause();
      await store.markForHub('leaves', 'l1', false);
      await pause();
      await store.markForHub('conversations', 'c1', true);
      const all = await store.hubDirty(10);
      expect(all.map((entry) => `${entry.kind}/${entry.id}`)).toEqual(['trees/t1', 'leaves/l1', 'conversations/c1']);
      expect(all.map((entry) => entry.deleted)).toEqual([false, false, true]);
      expect(all.every((entry) => typeof entry.at === 'string')).toBe(true);
      expect((await store.hubDirty(2)).map((entry) => entry.id)).toEqual(['t1', 'l1']);
      expect(Object.keys(all[0]!).sort()).toEqual(['at', 'deleted', 'id', 'kind']);
    });

    it('marking a record again keeps one entry, with the latest word on whether it was deleted, queued last', async () => {
      const store = await make();
      await store.saveHubLink(link('p1'));
      await store.markForHub('trees', 't1', false);
      await pause();
      await store.markForHub('trees', 't2', false);
      await pause();
      await store.markForHub('trees', 't1', true);
      const entries = await store.hubDirty(10);
      expect(entries.map((entry) => [entry.id, entry.deleted])).toEqual([['t2', false], ['t1', true]]);
    });

    it('treats the same id of two kinds as two records', async () => {
      const store = await make();
      await store.saveHubLink(link('p1'));
      await store.markForHub('trees', 'same', false);
      await store.markForHub('leaves', 'same', false);
      expect((await store.hubDirty(10)).map((entry) => entry.kind).sort()).toEqual(['leaves', 'trees']);
    });

    it('clears an entry only if it has not been marked again since it was read', async () => {
      const store = await make();
      await store.saveHubLink(link('p1'));
      await store.markForHub('trees', 't1', false);
      await store.markForHub('trees', 't2', false);
      const read = await store.hubDirty(10);
      await pause();
      await store.markForHub('trees', 't2', true);
      await store.clearHubDirty(read);
      const left = await store.hubDirty(10);
      expect(left.map((entry) => [entry.id, entry.deleted])).toEqual([['t2', true]]);
      await store.clearHubDirty(left);
      expect(await store.hubDirty(10)).toEqual([]);
    });
  });

  describe('records kept as the hub last agreed them', () => {
    it('has nothing for a record never patched', async () => {
      const store = await make();
      expect(await store.syncedRecord('trees', 'nope')).toBeUndefined();
    });

    it('makes a record from the first patch and changes only the fields a later one names', async () => {
      const store = await make();
      await store.patchSyncedRecord('trees', 't1', { set: { name: 'one', status: 'open', nested: { a: 1 } } });
      expect(await store.syncedRecord('trees', 't1')).toEqual({ id: 't1', name: 'one', status: 'open', nested: { a: 1 } });
      await store.patchSyncedRecord('trees', 't1', { set: { status: 'closed' }, unset: ['nested'] });
      expect(await store.syncedRecord('trees', 't1')).toEqual({ id: 't1', name: 'one', status: 'closed' });
    });

    it('makes an empty record when a patch only unsets fields of one that is not there', async () => {
      const store = await make();
      await store.patchSyncedRecord('leaves', 'l1', { unset: ['x'] });
      expect(await store.syncedRecord('leaves', 'l1')).toEqual({ id: 'l1' });
    });

    it('does nothing for a patch that names nothing', async () => {
      const store = await make();
      await store.patchSyncedRecord('leaves', 'l1', {});
      await store.patchSyncedRecord('leaves', 'l2', { set: {}, unset: [], messages: {} });
      expect(await store.syncedRecord('leaves', 'l1')).toBeUndefined();
      expect(await store.syncedRecord('leaves', 'l2')).toBeUndefined();
    });

    it('keeps each kind apart, even for the same id', async () => {
      const store = await make();
      await store.patchSyncedRecord('trees', 'same', { set: { name: 'tree' } });
      await store.patchSyncedRecord('branches', 'same', { set: { name: 'branch' } });
      expect((await store.syncedRecord('trees', 'same'))?.name).toBe('tree');
      expect((await store.syncedRecord('branches', 'same'))?.name).toBe('branch');
      await store.deleteSyncedRecord('trees', 'same');
      expect(await store.syncedRecord('trees', 'same')).toBeUndefined();
      expect((await store.syncedRecord('branches', 'same'))?.name).toBe('branch');
      await store.deleteSyncedRecord('trees', 'never');
    });

    it('keeps the messages of a conversation in the order they were said, whatever the order they arrive in', async () => {
      const store = await make();
      await store.patchSyncedRecord('conversations', 'c1', { set: { title: 'chat' }, messages: { put: [message('2026-10-01T00:00:03.000Z'), message('2026-10-01T00:00:01.000Z')] } });
      await store.patchSyncedRecord('conversations', 'c1', { messages: { put: [message('2026-10-01T00:00:02.000Z')] } });
      const stored = await store.syncedRecord('conversations', 'c1');
      expect(stored?.title).toBe('chat');
      expect((stored?.messages as ConversationMessage[]).map((each) => each.at)).toEqual(['2026-10-01T00:00:01.000Z', '2026-10-01T00:00:02.000Z', '2026-10-01T00:00:03.000Z']);
    });

    it('makes the record when a message is put on one that is not there', async () => {
      const store = await make();
      await store.patchSyncedRecord('conversations', 'c1', { messages: { put: [message('2026-10-01T00:00:01.000Z')] } });
      expect(await store.syncedRecord('conversations', 'c1')).toEqual({ id: 'c1', messages: [message('2026-10-01T00:00:01.000Z')] });
    });

    it('puts a message over the one that has the same role, moment and author', async () => {
      const store = await make();
      const at = '2026-10-01T00:00:01.000Z';
      await store.patchSyncedRecord('conversations', 'c1', { messages: { put: [message(at), message(at, { role: 'assistant', author: { kind: 'agent', slug: 'koala' } }), message(at, { author: { kind: 'person', id: 'bob' } })] } });
      await store.patchSyncedRecord('conversations', 'c1', { messages: { put: [message(at, { content: 'edited' })] } });
      const messages = (await store.syncedRecord('conversations', 'c1'))?.messages as ConversationMessage[];
      expect(messages).toHaveLength(3);
      expect(messages.filter((each) => each.content === 'edited')).toHaveLength(1);
      expect(messages.find((each) => each.content === 'edited')?.author).toEqual({ kind: 'person', id: 'ann' });
      expect(messages.find((each) => each.author && 'id' in each.author && each.author.id === 'bob')?.content).toBe(`said at ${at}`);
    });

    it('drops a message by its role, moment and author, whoever wrote it', async () => {
      const store = await make();
      const at = '2026-10-01T00:00:01.000Z';
      const platform = message(at, { role: 'notice', author: { kind: 'platform' } });
      const agent = message(at, { role: 'assistant', author: { kind: 'agent', slug: 'koala' } });
      const person = message(at);
      const anonymous: ConversationMessage = { role: 'user', content: 'no author', at };
      await store.patchSyncedRecord('conversations', 'c1', { messages: { put: [platform, agent, person, anonymous] } });
      await store.patchSyncedRecord('conversations', 'c1', { messages: { drop: [`notice|${at}|platform`, `assistant|${at}|agent:koala`] } });
      expect((await store.syncedRecord('conversations', 'c1'))?.messages).toEqual([person, anonymous]);
      await store.patchSyncedRecord('conversations', 'c1', { messages: { drop: [`user|${at}|`] } });
      expect((await store.syncedRecord('conversations', 'c1'))?.messages).toEqual([person]);
      await store.patchSyncedRecord('conversations', 'c1', { messages: { drop: [`user|${at}|person:ann`] } });
      expect((await store.syncedRecord('conversations', 'c1'))?.messages).toEqual([]);
    });

    it('drops nothing when the message or the record is not there', async () => {
      const store = await make();
      await store.patchSyncedRecord('conversations', 'gone', { messages: { drop: ['user|x|'] } });
      expect(await store.syncedRecord('conversations', 'gone')).toBeUndefined();
      await store.patchSyncedRecord('conversations', 'c1', { messages: { put: [message('2026-10-01T00:00:01.000Z')] } });
      await store.patchSyncedRecord('conversations', 'c1', { messages: { drop: ['user|2026-10-09T00:00:00.000Z|person:ann'] } });
      expect(((await store.syncedRecord('conversations', 'c1'))?.messages as unknown[]).length).toBe(1);
    });

    it('changes fields, drops and puts messages in one patch', async () => {
      const store = await make();
      const first = message('2026-10-01T00:00:01.000Z');
      await store.patchSyncedRecord('conversations', 'c1', { set: { title: 'before', stale: true }, messages: { put: [first] } });
      const second = message('2026-10-01T00:00:02.000Z');
      await store.patchSyncedRecord('conversations', 'c1', { set: { title: 'after' }, unset: ['stale'], messages: { drop: ['user|2026-10-01T00:00:01.000Z|person:ann'], put: [second] } });
      expect(await store.syncedRecord('conversations', 'c1')).toEqual({ id: 'c1', title: 'after', messages: [second] });
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.patchSyncedRecord('trees', 't1', { set: { nested: { list: ['a'] } } });
      const read = await store.syncedRecord('trees', 't1');
      (read!.nested as { list: string[] }).list.push('b');
      read!.name = 'changed';
      expect(await store.syncedRecord('trees', 't1')).toEqual({ id: 't1', nested: { list: ['a'] } });
    });
  });

  describe('snapshots of what the hub last agreed', () => {
    it('keeps a snapshot by kind and id with the project it is for, and replaces it when saved again', async () => {
      const store = await make();
      expect(await store.hubSnapshot('trees', 't1')).toBeUndefined();
      await store.saveHubSnapshot('p1', 'trees', { id: 't1', name: 'one', nested: { a: [1, 2] } });
      expect(await store.hubSnapshot('trees', 't1')).toEqual({ projectId: 'p1', doc: { id: 't1', name: 'one', nested: { a: [1, 2] } } });
      await store.saveHubSnapshot('p2', 'trees', { id: 't1', name: 'two' });
      expect(await store.hubSnapshot('trees', 't1')).toEqual({ projectId: 'p2', doc: { id: 't1', name: 'two' } });
    });

    it('keeps the same id of two kinds apart, and deletes one at a time', async () => {
      const store = await make();
      await store.saveHubSnapshot('p1', 'trees', { id: 'same', name: 'tree' });
      await store.saveHubSnapshot('p1', 'leaves', { id: 'same', name: 'leaf' });
      await store.deleteHubSnapshot('trees', 'same');
      expect(await store.hubSnapshot('trees', 'same')).toBeUndefined();
      expect((await store.hubSnapshot('leaves', 'same'))?.doc.name).toBe('leaf');
      await store.deleteHubSnapshot('trees', 'never');
    });

    it('deletes every snapshot of a project and no one else\'s', async () => {
      const store = await make();
      await store.saveHubSnapshot('p1', 'trees', { id: 't1' });
      await store.saveHubSnapshot('p1', 'leaves', { id: 'l1' });
      await store.saveHubSnapshot('p2', 'trees', { id: 't2' });
      await store.deleteHubSnapshots('p1');
      expect(await store.hubSnapshot('trees', 't1')).toBeUndefined();
      expect(await store.hubSnapshot('leaves', 'l1')).toBeUndefined();
      expect((await store.hubSnapshot('trees', 't2'))?.projectId).toBe('p2');
      await store.deleteHubSnapshots('nobody');
    });

    it('hands back a copy, and keeps the document as it was when saved', async () => {
      const store = await make();
      const doc = { id: 't1', nested: { list: ['a'] } };
      await store.saveHubSnapshot('p1', 'trees', doc);
      doc.nested.list.push('later');
      const read = await store.hubSnapshot('trees', 't1');
      (read!.doc.nested as { list: string[] }).list.push('b');
      expect((await store.hubSnapshot('trees', 't1'))?.doc).toEqual({ id: 't1', nested: { list: ['a'] } });
    });
  });
}
