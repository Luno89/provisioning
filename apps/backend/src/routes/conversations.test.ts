import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { conversationsRouter } from './conversations.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';

const harness: Harness = await mountRouter({
  prefix: '/api/conversations',
  router: (db: Database) => conversationsRouter({
    db,
    ownedConversations: async (userId: string) =>
      db.getConversations().then((c: any) => c.filter((x: any) => x.ownerId === userId)),
    ownedTrees: async (userId: string) => (await db.getTrees()).filter((tree) => tree.ownerId === userId),
    ownedProjects: async (userId: string) => (await db.getProjects()).filter((project) => project.ownerId === userId),
    workspaces: { conclude: async (ownerId: string, conversationId: string) => {
      concluded.push(`${ownerId}/${conversationId}`);
      if (concludeFails) throw new Error('Pushing to koala-u1/research-x failed: Gitea is down');
    } },
    turns: { settle: async (conversation) => (conversation.liveTurn ? { ...conversation, liveTurn: undefined, title: 'settled' } : conversation) },
  }),
});

let concluded: string[] = [];
let concludeFails = false;
beforeEach(() => { concluded = []; concludeFails = false; });

afterAll(async () => { await harness.close(); });

describe('deleting a conversation', () => {
  const create = async () => ((await (await fetch(harness.url('/api/conversations'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as { id: string }).id;

  it('saves its workspace first', async () => {
    const id = await create();
    expect((await fetch(harness.url(`/api/conversations/${id}`), { method: 'DELETE' })).status).toBe(200);
    expect(concluded).toEqual([`${TEST_USER.id}/${id}`]);
  });

  it('keeps the conversation when its workspace could not be saved', async () => {
    const id = await create();
    concludeFails = true;
    expect((await fetch(harness.url(`/api/conversations/${id}`), { method: 'DELETE' })).status).toBe(500);
    expect((await fetch(harness.url(`/api/conversations/${id}`))).status).toBe(200);
  });
});

describe('reading a conversation with a turn under way', () => {
  it('settles the turn first, so a turn whose run is gone never reads as still going', async () => {
    const id = ((await (await fetch(harness.url('/api/conversations'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as { id: string }).id;
    const db = harness.db as Database;
    const found = (await db.getConversations()).find((conversation) => conversation.id === id)!;
    await db.saveConversation({ ...found, liveTurn: { runId: 'r1', startedAt: 'then' } });

    const read = await (await fetch(harness.url(`/api/conversations/${id}`))).json() as { title: string; liveTurn?: unknown };

    expect(read.title).toBe('settled');
    expect(read.liveTurn).toBeUndefined();
  });
});

describe('conversation CRUD', () => {
  it('creates, lists, reads, and deletes a conversation', async () => {
    const createRes = await fetch(harness.url('/api/conversations'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'My Custom Thread' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string };
    expect(created.id).toBeDefined();

    const listRes = await fetch(harness.url('/api/conversations'));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as any[];
    expect(list.some((c: any) => c.id === created.id)).toBe(true);

    const getRes = await fetch(harness.url(`/api/conversations/${created.id}`));
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as { id: string };
    expect(got.id).toBe(created.id);

    const delRes = await fetch(harness.url(`/api/conversations/${created.id}`), { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const afterDel = (await harness.db.getConversations()).find((c: any) => c.id === created.id);
    expect(afterDel).toBeUndefined();
  });
});

describe('a conversation about a tree', () => {
  it('binds to a tree the person owns, and refuses one they do not', async () => {
    const stamp = new Date().toISOString();
    await harness.db.saveTree({ id: 'mine', ownerId: TEST_USER.id, name: 'Mine', type: 'software', projectIds: [], createdAt: stamp, updatedAt: stamp });
    await harness.db.saveTree({ id: 'theirs', ownerId: 'someone-else', name: 'Theirs', type: 'software', projectIds: [], createdAt: stamp, updatedAt: stamp });
    const create = (treeId: string) => fetch(harness.url('/api/conversations'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Grow it', treeId }),
    });

    const bound = await create('mine');
    expect(bound.status).toBe(200);
    const created = (await bound.json()) as { id: string; treeId?: string };
    expect(created.treeId).toBe('mine');
    expect((await harness.db.getConversation(TEST_USER.id, created.id))?.treeId).toBe('mine');

    expect((await create('theirs')).status).toBe(404);
    expect((await create('nowhere')).status).toBe(404);
  });

  it('binds to a project the person owns, never to one they do not, and never to a tree and a project at once', async () => {
    await harness.db.saveProjectInfo({ id: 'p-mine', name: 'mine', ownerId: TEST_USER.id, appType: 'local', createdAt: 'now' } as never);
    await harness.db.saveProjectInfo({ id: 'p-theirs', name: 'theirs', ownerId: 'someone-else', appType: 'local', createdAt: 'now' } as never);
    const create = (body: Record<string, string>) => fetch(harness.url('/api/conversations'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    const bound = await create({ projectId: 'p-mine' });
    expect(bound.status).toBe(200);
    expect(((await bound.json()) as { projectId?: string }).projectId).toBe('p-mine');
    expect((await create({ projectId: 'p-theirs' })).status).toBe(404);
    expect((await create({ projectId: 'p-mine', treeId: 'mine' })).status).toBe(400);
  });
});

describe('conversation chat-owned picks', () => {
  it('patches the pinned model and agent slug on a conversation, strips them with null, and rejects empty or foreign patches', async () => {
    const createRes = await fetch(harness.url('/api/conversations'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Picks Thread' }),
    });
    const created = (await createRes.json()) as { id: string };

    const patchRes = await fetch(harness.url(`/api/conversations/${created.id}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'heron-70b', agentSlug: 'heron' }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as Record<string, unknown>;
    expect(patched.modelId).toBe('heron-70b');
    expect(patched.agentSlug).toBe('heron');

    const getRes = await fetch(harness.url(`/api/conversations/${created.id}`));
    const got = (await getRes.json()) as Record<string, unknown>;
    expect(got.modelId).toBe('heron-70b');
    expect(got.agentSlug).toBe('heron');

    // null strips both picks (back to defaults)
    const clearRes = await fetch(harness.url(`/api/conversations/${created.id}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: null, agentSlug: null }),
    });
    expect(clearRes.status).toBe(200);
    const cleared = (await clearRes.json()) as Record<string, unknown>;
    expect('modelId' in cleared).toBe(false);
    expect('agentSlug' in cleared).toBe(false);

    const emptyRes = await fetch(harness.url(`/api/conversations/${created.id}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(emptyRes.status).toBe(400);

    const foreign = { id: 'someone-else', email: 'other@example.com', isAdmin: false };
    harness.setUser(foreign);
    const foreignRes = await fetch(harness.url(`/api/conversations/${created.id}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'x' }),
    });
    expect(foreignRes.status).toBe(404);
    harness.setUser(TEST_USER);

    const missingRes = await fetch(harness.url('/api/conversations/never-existed'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'x' }),
    });
    expect(missingRes.status).toBe(404);
  });
});
