import { beforeEach, describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { Tree } from '../../projects/lib/trees.js';
import type { Conversation } from '../lib/conversations.js';
import { AutoModeService } from './AutoModeService.js';

const OWNER = 'u1';

const tree = (over: Partial<Tree> = {}): Tree => ({ id: 't1', ownerId: OWNER, name: 'Shop', type: 'odoo-addons', createdAt: 'a', updatedAt: 'a', ...over });
const chat = (over: Partial<Conversation> = {}): Conversation => ({ id: 'c1', ownerId: OWNER, title: 'Chat', messages: [], createdAt: 'a', updatedAt: 'a', ...over });

let db: Database;
let service: AutoModeService;

beforeEach(async () => {
  db = memoryDatabase();
  service = new AutoModeService({ store: db, agentExists: async (_ownerId, slug) => slug === 'executor' || slug === 'koala', now: () => 'now' });
  await db.projects.saveTree(tree());
  await db.projects.saveTree(tree({ id: 't2', ownerId: 'someone-else' }));
});

describe('auto mode', () => {
  it('switches an agent on and off and lists the agents that are on', async () => {
    expect(await service.setAgent(OWNER, 'executor', { on: true })).toEqual({ ok: true, value: { agents: ['executor'] } });
    await service.setAgent(OWNER, 'koala', { on: true });
    expect(await service.agents(OWNER)).toEqual(['executor', 'koala']);

    expect(await service.setAgent(OWNER, 'executor', { on: false })).toEqual({ ok: true, value: { agents: ['koala'] } });
    expect(await service.unasked({ ownerId: OWNER, agentSlug: 'executor' })).toBe(false);
    expect(await service.unasked({ ownerId: OWNER, agentSlug: 'koala' })).toBe(true);
  });

  it('keeps one person\'s agents apart from another\'s', async () => {
    await service.setAgent(OWNER, 'executor', { on: true });
    expect(await service.agents('someone-else')).toEqual([]);
    expect(await service.unasked({ ownerId: 'someone-else', agentSlug: 'executor' })).toBe(false);
  });

  it('refuses an agent there is none of, and a body that does not say on or off', async () => {
    expect(await service.setAgent(OWNER, 'nobody', { on: true })).toEqual({ ok: false, status: 404, error: 'Agent not found' });
    expect(await service.setAgent(OWNER, 'executor', { on: 'yes' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.setTree(OWNER, 't1', {})).toMatchObject({ ok: false, status: 400 });
    expect(await service.setConversation(OWNER, 'c1', { on: 'yes' })).toMatchObject({ ok: false, status: 400 });
  });

  it('switches a tree on, so every run working on it goes unasked, whatever its agent', async () => {
    expect(await service.setTree(OWNER, 't1', { on: true })).toEqual({ ok: true, value: { autoMode: true } });
    expect((await db.projects.getTrees()).find((entry) => entry.id === 't1')?.autoMode).toBe(true);
    expect(await service.unasked({ ownerId: OWNER, agentSlug: 'executor', treeId: 't1' })).toBe(true);
    expect(await service.unasked({ ownerId: OWNER, agentSlug: 'executor' })).toBe(false);

    await service.setTree(OWNER, 't1', { on: false });
    expect((await db.projects.getTrees()).find((entry) => entry.id === 't1')).not.toHaveProperty('autoMode');
    expect(await service.unasked({ ownerId: OWNER, agentSlug: 'executor', treeId: 't1' })).toBe(false);
  });

  it('refuses a tree that is not the person\'s', async () => {
    expect(await service.setTree(OWNER, 't2', { on: true })).toEqual({ ok: false, status: 404, error: 'Tree not found' });
    expect(await service.unasked({ ownerId: OWNER, agentSlug: 'executor', treeId: 't2' })).toBe(false);
  });

  it('finds the tree of a chat bound to it', async () => {
    await service.setTree(OWNER, 't1', { on: true });
    await db.engine.saveConversation(chat({ treeId: 't1' }));
    expect(await service.unasked({ ownerId: OWNER, agentSlug: 'koala', conversationId: 'c1' })).toBe(true);
  });

  it('switches a chat on and off without touching what it holds', async () => {
    await db.engine.saveConversation(chat({ id: 'c2', messages: [{ role: 'user', content: 'hi' } as Conversation['messages'][number]] }));
    await db.engine.saveConversation(chat({ id: 'c3', ownerId: 'someone-else' }));

    expect(await service.setConversation(OWNER, 'c2', { on: true })).toEqual({ ok: true, value: { autoMode: true } });
    expect(await service.unasked({ ownerId: OWNER, agentSlug: 'research', conversationId: 'c2' })).toBe(true);
    expect(await service.unasked({ ownerId: OWNER, agentSlug: 'research' })).toBe(false);
    expect((await db.engine.getConversation(OWNER, 'c2'))?.messages).toHaveLength(1);

    expect(await service.setConversation(OWNER, 'c2', { on: false })).toEqual({ ok: true, value: { autoMode: false } });
    expect(await db.engine.getConversation(OWNER, 'c2')).not.toHaveProperty('autoMode');
    expect(await service.unasked({ ownerId: OWNER, agentSlug: 'research', conversationId: 'c2' })).toBe(false);

    expect(await service.setConversation(OWNER, 'c3', { on: true })).toEqual({ ok: false, status: 404, error: 'Conversation not found' });
  });
});
