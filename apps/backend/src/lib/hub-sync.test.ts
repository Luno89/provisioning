import { describe, expect, it } from 'vitest';
import { applyPatch, diffRecord, fieldUpdate, inScope, messageKey, messageUpdates, scopeOf, type SyncedDoc } from './hub-sync.js';

const leaf = (fields: Record<string, unknown> = {}): SyncedDoc => ({ id: 'l1', branchId: 'b1', title: 'Checkout', status: 'pending', ...fields });
const said = (at: string, content: string, author?: { kind: 'person'; id: string }) => ({ role: 'user' as const, at, content, ...(author ? { author } : {}) });

describe('what changed in a record, and laying it over another copy', () => {
  it('names only the fields that changed, and the ones taken away', () => {
    expect(diffRecord(leaf(), leaf())).toBeUndefined();
    expect(diffRecord(leaf({ priority: 2 }), leaf({ status: 'running' }))).toEqual({ set: { status: 'running' }, unset: ['priority'] });
    expect(diffRecord(undefined, leaf())).toEqual({ set: { branchId: 'b1', title: 'Checkout', status: 'pending' } });
  });

  it('keeps both sides when each changed a different field, and the later one when both changed the same', () => {
    const agreed = leaf();
    const fromInstance = diffRecord(agreed, leaf({ status: 'running' }))!;
    const fromMember = diffRecord(agreed, leaf({ priority: 1, title: 'Pay' }))!;
    const onHub = applyPatch(applyPatch(agreed, 'l1', fromMember), 'l1', fromInstance);
    expect(onHub).toEqual(leaf({ status: 'running', priority: 1, title: 'Pay' }));
    expect(applyPatch(onHub, 'l1', diffRecord(agreed, leaf({ title: 'Checkout page' }))!).title).toBe('Checkout page');
  });

  it('treats a chat\'s messages one by one, so a post on one side and a reply on the other both stay, in time order', () => {
    const agreed: SyncedDoc = { id: 'c1', messages: [said('1', 'hello', { kind: 'person', id: 'ann' })] };
    const post = diffRecord(agreed, { ...agreed, messages: [...(agreed.messages as never[]), said('3', 'from the hub', { kind: 'person', id: 'bo' })] })!;
    const reply = diffRecord(agreed, { ...agreed, messages: [...(agreed.messages as never[]), { role: 'assistant', at: '2', content: 'koala' }] })!;
    expect(post).toEqual({ messages: { put: [said('3', 'from the hub', { kind: 'person', id: 'bo' })] } });
    const merged = applyPatch(applyPatch(agreed, 'c1', post), 'c1', reply);
    expect((merged.messages as { content: string }[]).map((message) => message.content)).toEqual(['hello', 'koala', 'from the hub']);
    const edited = diffRecord(merged, { ...merged, messages: (merged.messages as { content: string; at: string }[]).map((message) => (message.at === '2' ? { ...message, content: 'koala, finished' } : message)).filter((message) => message.at !== '1') })!;
    expect(edited.messages).toEqual({ put: [{ role: 'assistant', at: '2', content: 'koala, finished' }], drop: [messageKey(said('1', '', { kind: 'person', id: 'ann' }))] });
  });
});

describe('what belongs to a shared project', () => {
  const world = {
    trees: [{ id: 't1', projectIds: ['p1'] }, { id: 't2', projectIds: ['p2'] }],
    branches: [{ id: 'b1', treeId: 't1' }, { id: 'b2', treeId: 't2' }],
    leaves: [{ id: 'l1', branchId: 'b1' }, { id: 'l2', branchId: 'b2' }],
    conversations: [
      { id: 'channel', kind: 'channel', treeId: 't1', projectId: 'p1' },
      { id: 'story', kind: 'item', treeId: 't1', leafId: 'l1' },
      { id: 'private', treeId: 't1', projectId: 'p1' },
      { id: 'elsewhere', kind: 'channel', treeId: 't2' },
    ],
  };

  it('is its trees, their features and stories, their tasks, its channel and item chats and their cards, never a private chat or another project', () => {
    const scope = scopeOf('p1', world);
    expect([...scope.treeIds, ...scope.branchIds, ...scope.leafIds]).toEqual(['t1', 'b1', 'l1']);
    expect([...scope.conversationIds]).toEqual(['channel', 'story']);
    expect(inScope('tasks', { id: 'k1', leafId: 'l1' }, scope)).toBe(true);
    expect(inScope('tasks', { id: 'k2', leafId: 'l2' }, scope)).toBe(false);
    expect(inScope('planProposals', { id: 'p', conversationId: 'story' }, scope)).toBe(true);
    expect(inScope('planProposals', { id: 'q', conversationId: 'private' }, scope)).toBe(false);
  });
});

describe('applying a member\'s patch as field updates, so an engine write landing meanwhile is kept', () => {
  it('turns set and unset into one update and messages into a pull of the same keys and a sorted push', () => {
    expect(fieldUpdate({ set: { priority: 1 }, unset: ['waitingFor'] })).toEqual({ $set: { priority: 1 }, $unset: { waitingFor: '' } });
    expect(fieldUpdate({ messages: { put: [] } })).toBeUndefined();
    const put = [{ role: 'user' as const, content: 'hi', at: '2026-10-21T00:00:01Z', author: { kind: 'person' as const, id: 'cy' } }];
    expect(messageUpdates({ messages: { put, drop: ['assistant|2026-10-21T00:00:00Z|agent:koala', 'notice|2026-10-21T00:00:02Z|platform', 'user|2026-10-21T00:00:03Z|'] } })).toEqual({
      pull: [
        { role: 'assistant', at: '2026-10-21T00:00:00Z', author: { kind: 'agent', slug: 'koala' } },
        { role: 'notice', at: '2026-10-21T00:00:02Z', author: { kind: 'platform' } },
        { role: 'user', at: '2026-10-21T00:00:03Z', author: { $exists: false } },
        { role: 'user', at: '2026-10-21T00:00:01Z', author: { kind: 'person', id: 'cy' } },
      ],
      push: put,
    });
    expect(messageUpdates({ set: { title: 'x' } })).toEqual({});
  });
});
