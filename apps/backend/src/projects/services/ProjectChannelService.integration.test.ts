import { describe, it, expect } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { ProjectChannelService } from './ProjectChannelService.js';
import { ConversationNoticeService } from '../../engine/services/ConversationNoticeService.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';

const setup = async () => {
  const db = await testDatabase();
  const project: ProjectMetadata = { id: 'p1', name: 'Shop', ownerId: 'bo', appType: 'gitapp', createdAt: 't' };
  await db.projects.saveProject(project);
  const channels = new ProjectChannelService({
    conversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
    save: (conversation) => db.engine.saveConversation(conversation),
    bind: (ownerId, id, binding) => db.engine.bindConversation(ownerId, id, binding),
    trees: () => db.projects.getTrees(),
    saveProjectInfo: (entry) => db.projects.saveProjectInfo(entry),
    now: () => 'now',
  });
  return { db, project, channels };
};

describe('a project\'s channel', () => {
  it('is made once, named after the project, and recorded on it', async () => {
    const { db, project, channels } = await setup();
    const made = await channels.ensure(project);
    expect(made).toMatchObject({ id: 'channel-p1', ownerId: 'bo', title: 'Shop', kind: 'channel', projectId: 'p1', messages: [] });
    expect((await db.projects.getProjects())[0]!.channelId).toBe('channel-p1');
    await db.engine.appendMessage('bo', 'channel-p1', { role: 'user', content: 'hello', at: 't' });
    expect((await channels.ensure({ ...project, channelId: 'channel-p1' }))!.messages).toHaveLength(1);
    expect((await db.engine.getConversations()).filter((conversation) => conversation.kind === 'channel')).toHaveLength(1);
  });

  it('is bound to the project\'s tree once it has one, keeping what was said', async () => {
    const { db, project, channels } = await setup();
    await channels.ensure(project);
    await db.engine.appendMessage('bo', 'channel-p1', { role: 'user', content: 'before the tree', at: 't' });
    await db.projects.saveTree({ id: 't1', ownerId: 'bo', name: 'Shop', type: 'odoo-addons', projectIds: ['p1'], createdAt: 't', updatedAt: 't' } as never);
    expect(await channels.ensure(project)).toMatchObject({ treeId: 't1' });
    expect((await db.engine.getConversation('bo', 'channel-p1'))!.messages.map((message) => message.content)).toEqual(['before the tree']);
  });

  it('is where a project\'s notices go, not the other chats about it', async () => {
    const { db, project, channels } = await setup();
    await db.engine.saveConversation({ id: 'side', ownerId: 'bo', title: 'side', projectId: 'p1', messages: [], createdAt: 't', updatedAt: 't' });
    const notices = new ConversationNoticeService({
      conversations: () => db.engine.getConversations(),
      append: (ownerId, id, message) => db.engine.appendNotice(ownerId, id, message),
      told: () => undefined,
      channelOf: async () => (await channels.ensure(project))?.id,
    });
    expect(await notices.post('bo', { projectId: 'p1' }, { key: 'k', kind: 'release-live', text: 'live', refs: { projectId: 'p1' }, actions: [] })).toEqual(['channel-p1']);
    expect((await db.engine.getConversation('bo', 'side'))!.messages).toEqual([]);
  });

  it('has no channel for a project with no owner', async () => {
    const { project, channels } = await setup();
    const { ownerId: _none, ...ownerless } = project;
    expect(await channels.ensure(ownerless)).toBeUndefined();
  });
});
