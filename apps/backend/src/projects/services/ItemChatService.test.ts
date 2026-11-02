import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { ItemChatService } from './ItemChatService.js';

const at = 'then';

async function setUp() {
  const db = memoryDatabase();
  const service = new ItemChatService({
    leaves: () => db.projects.getLeaves(),
    branches: () => db.projects.getBranches(),
    trees: () => db.projects.getTrees(),
    conversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
    save: (conversation) => db.engine.saveConversation(conversation),
    now: () => 'stamped',
  });
  await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo-addons', createdAt: at, updatedAt: at });
  await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Payments', createdAt: at, updatedAt: at });
  await db.projects.saveLeaf({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'pending', createdAt: at, updatedAt: at });
  await db.projects.saveBranch({ id: 'b-theirs', ownerId: 'bo', treeId: 't9', title: 'Theirs', createdAt: at, updatedAt: at });
  await db.projects.saveLeaf({ id: 'l-theirs', ownerId: 'bo', branchId: 'b-theirs', title: 'Theirs', status: 'pending', createdAt: at, updatedAt: at });
  return { db, service };
}

describe('the chat of a story', () => {
  it('is made the first time it is asked for, titled for the story and bound to it and its tree', async () => {
    const { db, service } = await setUp();
    const chat = await service.ensure('ann', { kind: 'story', leafId: 'l1' });
    expect(chat).toEqual({ id: 'story-l1', ownerId: 'ann', title: 'Checkout', kind: 'item', treeId: 't1', leafId: 'l1', messages: [], createdAt: 'stamped', updatedAt: 'stamped' });
    expect(await db.engine.getConversation('ann', 'story-l1')).toEqual(chat);
  });

  it('is the same chat the next time, with what was said in it', async () => {
    const { db, service } = await setUp();
    await service.ensure('ann', { kind: 'story', leafId: 'l1' });
    await db.engine.saveConversation({ ...(await db.engine.getConversation('ann', 'story-l1'))!, messages: [{ role: 'user', content: 'hi', at }] });
    expect((await service.ensure('ann', { kind: 'story', leafId: 'l1' }))?.messages).toHaveLength(1);
  });

  it('is not made for another owner\'s story or one that is not there', async () => {
    const { db, service } = await setUp();
    expect(await service.ensure('ann', { kind: 'story', leafId: 'l-theirs' })).toBeUndefined();
    expect(await service.ensure('ann', { kind: 'story', leafId: 'nope' })).toBeUndefined();
    expect(await db.engine.getConversations()).toEqual([]);
  });

  it('is not made for a story whose tree is gone', async () => {
    const { db, service } = await setUp();
    await db.projects.deleteTree('t1');
    expect(await service.ensure('ann', { kind: 'story', leafId: 'l1' })).toBeUndefined();
  });
});

describe('the chat of a feature', () => {
  it('is made titled for the feature and bound to it and its tree', async () => {
    const { service } = await setUp();
    expect(await service.ensure('ann', { kind: 'feature', branchId: 'b1' })).toEqual({ id: 'feature-b1', ownerId: 'ann', title: 'Payments', kind: 'item', treeId: 't1', branchId: 'b1', messages: [], createdAt: 'stamped', updatedAt: 'stamped' });
  });

  it('is not made for another owner\'s feature or one that is not there', async () => {
    const { service } = await setUp();
    expect(await service.ensure('ann', { kind: 'feature', branchId: 'b-theirs' })).toBeUndefined();
    expect(await service.ensure('ann', { kind: 'feature', branchId: 'nope' })).toBeUndefined();
  });
});
