import { describe, it, expect, afterEach } from 'vitest';
import axios from 'axios';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { ItemChatService } from './ItemChatService.js';
import { conversationBinding } from '../../engine-host/conversation-binding.js';
import { BINDING_INPUTS } from '../../engine-host/registries/run-starter.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { itemChatsRouter } from '../routes/item-chats.js';

const seed = async (db: MongoDB, ownerId: string) => {
  await db.projects.saveTree({ id: 't1', ownerId, name: 'Shop', type: 'odoo-addons', createdAt: 't', updatedAt: 't' } as never);
  await db.projects.saveBranch({ id: 'b1', ownerId, treeId: 't1', title: 'The field', createdAt: 't', updatedAt: 't' });
  await db.projects.saveLeaf({ id: 'l1', ownerId, branchId: 'b1', title: 'Module installs', body: 'Add delivery_instructions to sale.order.', status: 'failed', findings: 'the view did not load', createdAt: 't', updatedAt: 't' });
};

const service = (db: MongoDB) => new ItemChatService({
  leaves: () => db.projects.getLeaves(),
  branches: () => db.projects.getBranches(),
  trees: () => db.projects.getTrees(),
  conversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
  save: (conversation) => db.engine.saveConversation(conversation),
  now: () => 'now',
});

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('a story\'s or a feature\'s own chat', () => {
  it('is made once, named after the item, bound to it and its tree, and kept apart from the tree\'s threads', async () => {
    const db = await testDatabase();
    await seed(db, 'bo');
    const items = service(db);
    const story = await items.ensure('bo', { kind: 'story', leafId: 'l1' });
    expect(story).toEqual({ id: 'story-l1', ownerId: 'bo', title: 'Module installs', kind: 'item', treeId: 't1', leafId: 'l1', messages: [], createdAt: 'now', updatedAt: 'now' });
    await db.engine.appendMessage('bo', 'story-l1', { role: 'user', content: 'why did it fail?', at: 't' });
    expect((await items.ensure('bo', { kind: 'story', leafId: 'l1' }))!.messages).toHaveLength(1);
    expect(await items.ensure('bo', { kind: 'feature', branchId: 'b1' })).toMatchObject({ id: 'feature-b1', title: 'The field', branchId: 'b1', treeId: 't1' });
  });

  it('is not made for someone else\'s item, or one that does not exist', async () => {
    const db = await testDatabase();
    await seed(db, 'bo');
    expect(await service(db).ensure('cy', { kind: 'story', leafId: 'l1' })).toBeUndefined();
    expect(await service(db).ensure('bo', { kind: 'story', leafId: 'nope' })).toBeUndefined();
    expect(await service(db).ensure('bo', { kind: 'feature', branchId: 'nope' })).toBeUndefined();
  });

  it('hands Koala the story — what it is, where it sits, and what went wrong — on every turn in it, and a feature its stories', async () => {
    const db = await testDatabase();
    await seed(db, 'bo');
    await service(db).ensure('bo', { kind: 'story', leafId: 'l1' });
    await service(db).ensure('bo', { kind: 'feature', branchId: 'b1' });
    await db.accounts.saveUser({ id: 'bo', email: 'bo@example.com', twoFactorEnabled: false, emailVerified: true } as never);
    const bound = conversationBinding(db);
    const story = await bound('bo', 'story-l1');
    expect(story).toMatchObject({ treeId: 't1', leafId: 'l1' });
    expect(Object.keys(story!)[0]).toBe('chat');
    expect(story!.chat).toBe('This is the chat about the story below. Every message here is to you; each says who wrote it. bo@example.com is talking with you now.');
    expect((await bound('bo', 'feature-b1'))!.chat).toContain('the chat about the feature below');
    expect(story!.story).toContain('Story "Module installs" (l1), in the feature "The field" (b1) of tree "Shop" (t1).');
    expect(story!.story).toContain('Findings: the view did not load');
    expect((await bound('bo', 'feature-b1'))!.feature).toContain('  - Module installs (l1) [failed]');
    expect(BINDING_INPUTS).toEqual(expect.arrayContaining(['leafId', 'story', 'branchId', 'feature']));
  });

  it('is opened over HTTP as the person, and refused for anything but a story or a feature of theirs', async () => {
    h = await mountRouter({ prefix: '/api/items', router: (db) => itemChatsRouter({ items: service(db as MongoDB) }) });
    await seed(h.db as MongoDB, TEST_USER.id);
    const opened = await axios.post(h.url('/api/items/story/l1/chat'), {}, { validateStatus: () => true });
    expect(opened.status).toBe(200);
    expect(opened.data).toEqual({ id: 'story-l1', title: 'Module installs' });
    expect((await axios.post(h.url('/api/items/feature/b1/chat'), {}, { validateStatus: () => true })).data).toEqual({ id: 'feature-b1', title: 'The field' });
    expect((await axios.post(h.url('/api/items/story/nope/chat'), {}, { validateStatus: () => true })).status).toBe(404);
    expect((await axios.post(h.url('/api/items/tree/t1/chat'), {}, { validateStatus: () => true })).status).toBe(404);
  });

});
