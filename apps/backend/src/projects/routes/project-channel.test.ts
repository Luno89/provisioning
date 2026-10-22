import { describe, it, expect, afterEach } from 'vitest';
import axios from 'axios';
import { Router } from 'express';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { projectChannelRouter } from './project-channel.js';
import { conversationsRouter } from '../../engine/routes/conversations.js';
import { ProjectChannelService } from '../services/ProjectChannelService.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('a project\'s channel over HTTP', () => {
  it('is made when first opened, lists the other chats about the project as threads, and takes plain messages without a turn', async () => {
    const posted: string[] = [];
    h = await mountRouter({
      prefix: '/api',
      router: (db) => {
        const channels = new ProjectChannelService({
          conversation: (ownerId, id) => db.getConversation(ownerId, id),
          save: (conversation) => db.saveConversation(conversation),
          bind: (ownerId, id, binding) => db.bindConversation(ownerId, id, binding),
          trees: () => db.projects.getTrees(),
          saveProjectInfo: (entry) => db.projects.saveProjectInfo(entry),
        });
        const mine = async (ownerId: string) => (await db.getConversations()).filter((conversation) => conversation.ownerId === ownerId);
        const both = Router();
        both.use(projectChannelRouter({ channels, conversations: mine, getOwnedProject: async (id) => (await db.projects.getProjects()).find((project) => project.id === id) ?? undefined }));
        both.use(conversationsRouter({ db, ownedConversations: mine, posted: (ownerId, id) => { posted.push(`${ownerId} ${id}`); } }));
        return both;
      },
    });
    await h.db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: TEST_USER.id, appType: 'gitapp', createdAt: 't' });
    await h.db.saveConversation({ id: 'side', ownerId: TEST_USER.id, title: 'About the discount', projectId: 'p1', messages: [], createdAt: 't', updatedAt: 't' });

    const opened = (await axios.get(h.url('/api/p1/channel'))).data;
    expect(opened).toEqual({ channel: { id: 'channel-p1', title: 'Shop' }, threads: [{ id: 'side', title: 'About the discount', updatedAt: 't', messageCount: 0 }] });

    const said = await axios.post(h.url('/api/channel-p1/messages'), { content: '  the shop opens at 9  ' }, { validateStatus: () => true });
    expect(said.status).toBe(201);
    expect(said.data.message).toMatchObject({ role: 'user', author: { kind: 'person', id: TEST_USER.id }, content: 'the shop opens at 9' });
    expect(posted).toEqual([`${TEST_USER.id} channel-p1`]);
    expect((await axios.post(h.url('/api/channel-p1/messages'), { content: ' ' }, { validateStatus: () => true })).status).toBe(400);
    expect((await axios.post(h.url('/api/side/messages'), { content: 'hi' }, { validateStatus: () => true })).status).toBe(409);
    expect((await axios.get(h.url('/api/p9/channel'), { validateStatus: () => true })).status).toBe(404);
  });
});
