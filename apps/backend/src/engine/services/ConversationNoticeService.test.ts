import { describe, it, expect } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { ConversationNoticeService } from './ConversationNoticeService.js';
import { asChatMessages } from '../../engine-host/nodes/conversation-nodes.js';

const notice = { key: 'release:r2:live', kind: 'release-live' as const, text: '57fce1a0 is live in slot b.', refs: { projectId: 'p1' }, actions: ['open-app' as const] };

describe('telling the chats about a project what happened', () => {
  it('posts once to every conversation of the owner bound to the tree or the project, and tells each one', async () => {
    const db = await testDatabase();
    const conversation = (id: string, over: Record<string, unknown>) => db.engine.saveConversation({ id, ownerId: 'bo', title: id, messages: [], createdAt: 't', updatedAt: 't', ...over } as never);
    await conversation('by-project', { projectId: 'p1' });
    await conversation('by-tree', { treeId: 't1' });
    await conversation('unbound', {});
    await conversation('theirs', { projectId: 'p1', ownerId: 'cy' });
    const told: string[] = [];
    const service = new ConversationNoticeService({
      conversations: () => db.engine.getConversations(),
      append: (ownerId, id, message) => db.engine.appendNotice(ownerId, id, message),
      told: (ownerId, id) => { told.push(`${ownerId} ${id}`); },
      now: () => '2026-10-09T21:00:00Z',
    });

    expect(await service.post('bo', { projectId: 'p1', treeId: 't1' }, notice)).toEqual(['by-project', 'by-tree']);
    expect(await service.post('bo', { projectId: 'p1', treeId: 't1' }, notice)).toEqual([]);
    expect(told).toEqual(['bo by-project', 'bo by-tree']);
    const stored = (await db.engine.getConversation('bo', 'by-project'))!.messages;
    expect(stored).toEqual([{ role: 'notice', author: { kind: 'platform' }, content: '57fce1a0 is live in slot b.', at: '2026-10-09T21:00:00Z', notice }]);
    expect((await db.engine.getConversation('bo', 'unbound'))!.messages).toEqual([]);
    expect((await db.engine.getConversation('cy', 'theirs'))!.messages).toEqual([]);
  });
});

describe('a notice as the model sees it', () => {
  it('is labelled as the platform\'s, never passed off as something the person said', () => {
    expect(asChatMessages([
      { role: 'user', content: 'Add the field.', at: 't' },
      { role: 'assistant', content: 'Planned.', at: 't' },
      { role: 'notice', author: { kind: 'platform' }, content: '57fce1a0 is live in slot b.', at: 't', notice },
    ])).toEqual([
      { role: 'user', content: 'Add the field.' },
      { role: 'assistant', content: 'Planned.' },
      { role: 'user', content: 'From the platform, not the person: 57fce1a0 is live in slot b.' },
    ]);
  });
});

describe('a notice about one story', () => {
  it('is told in full in the story\'s own chat, and in one line linking to it in the channel; other chats about the tree hear nothing', async () => {
    const db = await testDatabase();
    await db.engine.saveConversation({ id: 'channel-p1', ownerId: 'bo', title: 'Shop', kind: 'channel', projectId: 'p1', messages: [], createdAt: 't', updatedAt: 't' });
    await db.engine.saveConversation({ id: 'story-l9', ownerId: 'bo', title: 'Other story', kind: 'item', treeId: 't1', leafId: 'l9', messages: [], createdAt: 't', updatedAt: 't' });
    const asked: string[] = [];
    const service = new ConversationNoticeService({
      conversations: () => db.engine.getConversations(),
      append: (ownerId, id, message) => db.engine.appendNotice(ownerId, id, message),
      told: () => undefined,
      channelOf: async () => 'channel-p1',
      itemChatOf: async (_ownerId, item) => {
        asked.push(item.kind === 'story' ? item.leafId : item.branchId);
        if (!await db.engine.getConversation('bo', 'story-l2')) await db.engine.saveConversation({ id: 'story-l2', ownerId: 'bo', title: 'The proof', kind: 'item', treeId: 't1', leafId: 'l2', messages: [], createdAt: 't', updatedAt: 't' });
        return 'story-l2';
      },
      now: () => 'now',
    });
    const failed = { key: 'leaf:l2:failed:run', kind: 'leaf-failed' as const, text: 'The story "The proof" failed: the spec could not sign in.', line: 'The story "The proof" failed; what went wrong is in its chat.', refs: { treeId: 't1', projectId: 'p1', branchId: 'b2', leafId: 'l2' }, actions: ['open-tree' as const] };

    expect(await service.post('bo', { treeId: 't1', projectId: 'p1' }, failed)).toEqual(['story-l2', 'channel-p1']);
    expect(asked).toEqual(['l2']);
    expect((await db.engine.getConversation('bo', 'story-l2'))!.messages[0]).toMatchObject({ role: 'notice', content: failed.text, notice: failed });
    expect((await db.engine.getConversation('bo', 'channel-p1'))!.messages[0]).toMatchObject({ role: 'notice', content: failed.line, notice: { key: 'leaf:l2:failed:run:line', actions: ['open-story'], refs: failed.refs } });
    expect((await db.engine.getConversation('bo', 'story-l9'))!.messages).toEqual([]);
    expect(await service.post('bo', { treeId: 't1', projectId: 'p1' }, failed)).toEqual([]);
  });

  it('never lands in a story\'s chat when it is about the whole tree', async () => {
    const db = await testDatabase();
    await db.engine.saveConversation({ id: 'planning', ownerId: 'bo', title: 'Planning', treeId: 't1', messages: [], createdAt: 't', updatedAt: 't' });
    await db.engine.saveConversation({ id: 'story-l9', ownerId: 'bo', title: 'A story', kind: 'item', treeId: 't1', leafId: 'l9', messages: [], createdAt: 't', updatedAt: 't' });
    const service = new ConversationNoticeService({ conversations: () => db.engine.getConversations(), append: (ownerId, id, message) => db.engine.appendNotice(ownerId, id, message), told: () => undefined });
    expect(await service.post('bo', { treeId: 't1' }, { key: 'tree:run:ok', kind: 'tree-quiet', text: 'Shop finished growing.', refs: { treeId: 't1' }, actions: ['open-tree'] })).toEqual(['planning']);
  });
});
