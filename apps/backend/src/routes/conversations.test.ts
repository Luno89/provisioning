import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { conversationsRouter } from './conversations.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';
import { conversationBinding } from '../engine-host/conversation-binding.js';

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
    binding: conversationBinding(db),
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

describe('what Koala sees in a conversation', () => {
  const save = (id: string, bound: Record<string, string>, ownerId = TEST_USER.id) => harness.db.saveConversation({ id, ownerId, title: id, messages: [], createdAt: 't', updatedAt: 't', ...bound } as never);
  const context = async (id: string) => {
    const response = await fetch(harness.url(`/api/conversations/${id}/context`));
    return { status: response.status, body: response.status === 200 ? await response.json() as { given: Record<string, string>; text: string } : undefined };
  };

  it('keeps how far the conversation\'s model reaches, clears it with null, and ignores a reach it does not know', async () => {
    const created = (await (await fetch(harness.url('/api/conversations'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as { id: string };
    const patch = (body: unknown) => fetch(harness.url(`/api/conversations/${created.id}`), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    expect(((await (await patch({ modelId: 'machine:d1:antigravity', modelReach: 'chat' })).json()) as { modelReach?: string }).modelReach).toBe('chat');
    expect((await patch({ modelReach: 'everyone' })).status).toBe(400);
    expect(((await (await patch({ modelReach: null })).json()) as { modelReach?: string }).modelReach).toBeUndefined();
  });

  it('is shown at every level a conversation can be about: a project, a tree, a feature, a story', async () => {
    const owner = TEST_USER.id;
    await harness.db.saveTree({ id: 'ctx-t', ownerId: owner, name: 'Shop', type: 'odoo-addons', goal: 'Delivery notes', projectIds: ['ctx-p'], createdAt: 't', updatedAt: 't' } as never);
    await harness.db.saveBranch({ id: 'ctx-b', ownerId: owner, treeId: 'ctx-t', title: 'The field', createdAt: 't', updatedAt: 't' });
    await harness.db.saveLeaf({ id: 'ctx-l', ownerId: owner, branchId: 'ctx-b', title: 'Module installs', body: 'Add the field.', status: 'failed', findings: 'the view did not load', createdAt: 't', updatedAt: 't' });
    await harness.db.saveProject({ id: 'ctx-p', ownerId: owner, name: 'Bare', giteaOwner: 'o', giteaRepo: 'r', createdAt: 't' } as never);
    const release = { ownerId: owner, projectId: 'ctx-p', image: 'i', host: 'h', updatedAt: '2026-10-09T10:00:00Z' };
    await harness.db.saveOdooRelease({ ...release, id: 'ctx-r1', pipelineRunId: 'ctx-run1', commit: 'aaaaaaaa11', slot: 'a', state: 'live', liveAt: '2026-10-09T10:05:00Z', startedAt: '2026-10-09T10:00:00Z' });
    await harness.db.saveOdooRelease({ ...release, id: 'ctx-r2', pipelineRunId: 'ctx-run2', commit: 'bbbbbbbb22', slot: 'b', state: 'preview', startedAt: '2026-10-10T09:00:00Z' });
    await harness.db.savePipelineRun({ id: 'ctx-run2', projectId: 'ctx-p', commitSha: 'bbbbbbbb22', ref: 'main', status: 'succeeded', startedAt: '2026-10-10T08:55:00Z', finishedAt: '2026-10-10T08:59:00Z' });
    await save('ctx-story', { treeId: 'ctx-t', leafId: 'ctx-l' });
    await save('ctx-feature', { treeId: 'ctx-t', branchId: 'ctx-b' });
    await save('ctx-channel', { treeId: 'ctx-t', projectId: 'ctx-p' });
    await save('ctx-project', { projectId: 'ctx-p' });
    await save('ctx-loose', {});

    const story = (await context('ctx-story')).body!;
    expect(Object.keys(story.given)).toEqual(['treeId', 'leafId', 'story', 'project']);
    expect(story.given.story).toContain('Findings: the view did not load');
    expect(story.given.project).toContain('Live: aaaaaaaa in slot a');
    expect(story.text).toBe(`treeId: ctx-t\n\nleafId: ctx-l\n\nstory: ${story.given.story}\n\nproject: ${story.given.project}`);
    const feature = (await context('ctx-feature')).body!;
    expect(Object.keys(feature.given)).toEqual(['treeId', 'branchId', 'feature', 'project']);
    expect(feature.given.feature).toContain('Feature "The field" (ctx-b)');
    expect(feature.given.project).toContain('Waiting for the person: bbbbbbbb');
    const channel = (await context('ctx-channel')).body!;
    expect(Object.keys(channel.given)).toEqual(['treeId', 'tree', 'project']);
    expect(channel.given.tree).toContain('Tree "Shop" (ctx-t), type odoo-addons.');
    expect(channel.given.project).toContain('Live: aaaaaaaa in slot a, since 2026-10-09 10:05 UTC.');
    expect(channel.given.project).toContain('Waiting for the person: bbbbbbbb is ready to preview in slot b.');
    expect(channel.given.project).toContain('Last build: succeeded, bbbbbbbb, 2026-10-10 08:59 UTC.');
    const project = (await context('ctx-project')).body!.given.project!;
    expect(project).toContain('Project "Bare" (ctx-p)');
    expect(project).toContain('Live: aaaaaaaa in slot a');
    expect(project).toContain('It has no Grove tree yet');
    expect((await context('ctx-loose')).body).toEqual({ given: {}, text: '' });
  });

  it('is not shown for someone else\'s conversation', async () => {
    await save('ctx-theirs', { projectId: 'ctx-p' }, 'someone-else');
    expect((await context('ctx-theirs')).status).toBe(404);
    expect((await context('ctx-nope')).status).toBe(404);
  });
});
