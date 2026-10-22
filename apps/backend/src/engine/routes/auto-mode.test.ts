import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { autoModeRouter } from './auto-mode.js';
import { AutoModeService } from '../services/AutoModeService.js';
import type { Tree } from '../../projects/lib/trees.js';

const tree = (over: Partial<Tree> = {}): Tree => ({ id: 't1', ownerId: TEST_USER.id, name: 'Shop', type: 'odoo-addons', createdAt: 'a', updatedAt: 'a', ...over });

let harness: Harness;
let service: AutoModeService;

beforeEach(async () => {
  harness = await mountRouter({
    prefix: '/api/auto-mode',
    router: (db) => {
      service = new AutoModeService({ store: db, agentExists: async (_ownerId, slug) => slug === 'executor' || slug === 'koala', now: () => 'now' });
      return autoModeRouter({ autoMode: service });
    },
  });
  await harness.db.saveTree(tree());
  await harness.db.saveTree(tree({ id: 't2', ownerId: 'someone-else' }));
});

afterEach(() => harness.close());

const put = (path: string, body: unknown) => axios.put(harness.url(`/api/auto-mode${path}`), body, { validateStatus: () => true });

describe('auto mode', () => {
  it('switches an agent on and off, and lists the agents that are on', async () => {
    expect((await put('/agents/executor', { on: true })).data).toEqual({ agents: ['executor'] });
    await put('/agents/koala', { on: true });
    expect((await axios.get(harness.url('/api/auto-mode'))).data).toEqual({ agents: ['executor', 'koala'] });

    expect((await put('/agents/executor', { on: false })).data).toEqual({ agents: ['koala'] });
    expect(await service.unasked({ ownerId: TEST_USER.id, agentSlug: 'executor' })).toBe(false);
    expect(await service.unasked({ ownerId: TEST_USER.id, agentSlug: 'koala' })).toBe(true);
  });

  it('switches a tree on, so every run working on it goes unasked, whatever its agent', async () => {
    expect((await put('/trees/t1', { on: true })).data).toEqual({ autoMode: true });
    expect((await harness.db.getTrees()).find((entry) => entry.id === 't1')?.autoMode).toBe(true);

    expect(await service.unasked({ ownerId: TEST_USER.id, agentSlug: 'executor', treeId: 't1' })).toBe(true);
    expect(await service.unasked({ ownerId: TEST_USER.id, agentSlug: 'executor' })).toBe(false);

    await put('/trees/t1', { on: false });
    expect((await harness.db.getTrees()).find((entry) => entry.id === 't1')).not.toHaveProperty('autoMode');
    expect(await service.unasked({ ownerId: TEST_USER.id, agentSlug: 'executor', treeId: 't1' })).toBe(false);
  });

  it('finds the tree of a chat bound to it', async () => {
    await put('/trees/t1', { on: true });
    await harness.db.saveConversation({ id: 'c1', ownerId: TEST_USER.id, title: 'About the shop', treeId: 't1', messages: [], createdAt: 'a', updatedAt: 'a' } as never);

    expect(await service.unasked({ ownerId: TEST_USER.id, agentSlug: 'koala', conversationId: 'c1' })).toBe(true);
  });

  it('switches a chat on and off, so every run it starts goes unasked, whatever its agent, without touching what the chat holds', async () => {
    await harness.db.saveConversation({ id: 'c2', ownerId: TEST_USER.id, title: 'Machine reach', messages: [{ role: 'user', content: 'hi' }], createdAt: 'a', updatedAt: 'a' } as never);
    await harness.db.saveConversation({ id: 'c3', ownerId: 'someone-else', title: 'Theirs', messages: [], createdAt: 'a', updatedAt: 'a' } as never);

    expect((await put('/conversations/c2', { on: true })).data).toEqual({ autoMode: true });
    expect(await service.unasked({ ownerId: TEST_USER.id, agentSlug: 'research', conversationId: 'c2' })).toBe(true);
    expect(await service.unasked({ ownerId: TEST_USER.id, agentSlug: 'research' })).toBe(false);
    expect((await harness.db.getConversation(TEST_USER.id, 'c2'))?.messages).toHaveLength(1);

    expect((await put('/conversations/c2', { on: false })).data).toEqual({ autoMode: false });
    expect(await harness.db.getConversation(TEST_USER.id, 'c2')).not.toHaveProperty('autoMode');
    expect(await service.unasked({ ownerId: TEST_USER.id, agentSlug: 'research', conversationId: 'c2' })).toBe(false);

    expect((await put('/conversations/c3', { on: true })).status).toBe(404);
    expect((await put('/conversations/c2', { on: 'yes' })).status).toBe(400);
  });

  it('refuses a tree that is not yours, an agent there is none of, and a body that does not say on or off', async () => {
    expect((await put('/trees/t2', { on: true })).status).toBe(404);
    expect(await service.unasked({ ownerId: TEST_USER.id, agentSlug: 'executor', treeId: 't2' })).toBe(false);
    expect((await put('/agents/nobody', { on: true })).status).toBe(404);
    expect((await put('/agents/executor', { on: 'yes' })).status).toBe(400);
    expect((await put('/trees/t1', {})).status).toBe(400);
  });
});
