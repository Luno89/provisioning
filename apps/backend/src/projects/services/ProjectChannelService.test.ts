import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { ProjectChannelService } from './ProjectChannelService.js';

const at = 'then';

async function setUp() {
  const db = memoryDatabase();
  const service = new ProjectChannelService({
    conversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
    save: (conversation) => db.engine.saveConversation(conversation),
    bind: (ownerId, id, binding) => db.engine.bindConversation(ownerId, id, binding),
    trees: () => db.projects.getTrees(),
    saveProjectInfo: (entry) => db.projects.saveProjectInfo(entry),
    now: () => 'stamped',
  });
  await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: 'ann', appType: 'gitapp', createdAt: at });
  return { db, service };
}

describe('a project\'s channel', () => {
  it('is made the first time it is asked for, named for the project, and remembered on the project', async () => {
    const { db, service } = await setUp();
    const channel = await service.ensure({ id: 'p1', name: 'Shop', ownerId: 'ann' });
    expect(channel).toEqual({ id: 'channel-p1', ownerId: 'ann', title: 'Shop', kind: 'channel', projectId: 'p1', messages: [], createdAt: 'stamped', updatedAt: 'stamped' });
    expect(await db.engine.getConversation('ann', 'channel-p1')).toEqual(channel);
    expect((await db.projects.getProjects())[0]?.channelId).toBe('channel-p1');
  });

  it('is bound to the tree the project is the home of', async () => {
    const { db, service } = await setUp();
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo-addons', projectIds: ['p1'], createdAt: at, updatedAt: at });
    expect(await service.ensure({ id: 'p1', name: 'Shop', ownerId: 'ann' })).toMatchObject({ treeId: 't1' });
  });

  it('is the same channel the next time, and is written on a project that lost track of it', async () => {
    const { db, service } = await setUp();
    await service.ensure({ id: 'p1', name: 'Shop', ownerId: 'ann' });
    await db.projects.saveProjectInfo({ id: 'p1', channelId: 'lost' });
    expect(await service.ensure({ id: 'p1', name: 'Shop', ownerId: 'ann' })).toMatchObject({ id: 'channel-p1', createdAt: 'stamped' });
    expect((await db.projects.getProjects())[0]?.channelId).toBe('channel-p1');
  });

  it('is found by the id the project names, and the project is left as it is', async () => {
    const { db, service } = await setUp();
    await db.engine.saveConversation({ id: 'custom', ownerId: 'ann', title: 'Custom', kind: 'channel', projectId: 'p1', messages: [], createdAt: at, updatedAt: at });
    expect(await service.ensure({ id: 'p1', name: 'Shop', ownerId: 'ann', channelId: 'custom' })).toMatchObject({ id: 'custom', title: 'Custom' });
    expect((await db.projects.getProjects())[0]?.channelId).toBeUndefined();
  });

  it('is bound to its tree when the tree came after it', async () => {
    const { db, service } = await setUp();
    await service.ensure({ id: 'p1', name: 'Shop', ownerId: 'ann' });
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo-addons', projectIds: ['p1'], createdAt: at, updatedAt: at });
    expect(await service.ensure({ id: 'p1', name: 'Shop', ownerId: 'ann', channelId: 'channel-p1' })).toMatchObject({ treeId: 't1' });
    expect((await db.engine.getConversation('ann', 'channel-p1'))?.treeId).toBe('t1');
  });

  it('is not made for a project with no owner', async () => {
    const { db, service } = await setUp();
    expect(await service.ensure({ id: 'p1', name: 'Shop' })).toBeUndefined();
    expect(await db.engine.getConversations()).toEqual([]);
  });
});
