import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Conversation } from '../lib/conversations.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type InProcessRoutes } from '../../platform/testing/routes.js';
import { conversationsRouter, type ConversationsRouterDeps } from './conversations.js';

type Workspaces = NonNullable<ConversationsRouterDeps['workspaces']>;
type Turns = NonNullable<ConversationsRouterDeps['turns']>;

const chat = (over: Partial<Conversation> = {}): Conversation => ({ id: 'c1', ownerId: TEST_USER.id, title: 'Chat', messages: [], createdAt: 'a', updatedAt: 'a', ...over });

let app: InProcessRoutes;
let workspaces: ReturnType<typeof mock<Required<Workspaces>>>;
let turns: ReturnType<typeof mock<Turns>>;
let posted: string[];
let binding: Record<string, string> | undefined;

const mount = (drop: readonly (keyof ConversationsRouterDeps)[] = []) => routesInProcess({
  prefix: '/api/conversations',
  router: (db) => {
    const deps: ConversationsRouterDeps = {
    db,
    ownedConversations: async (userId) => (await db.engine.getConversations()).filter((one) => one.ownerId === userId),
    ownedTrees: async (userId) => (await db.projects.getTrees()).filter((tree) => tree.ownerId === userId),
    ownedProjects: async (userId) => (await db.projects.getProjects()).filter((project) => project.ownerId === userId),
    workspaces,
    turns,
    posted: (ownerId, conversationId) => { posted.push(`${ownerId}/${conversationId}`); },
    binding: async () => binding,
    };
    for (const key of drop) Reflect.deleteProperty(deps, key);
    return conversationsRouter(deps);
  },
});

beforeEach(async () => {
  workspaces = mock<Required<Workspaces>>();
  turns = mock<Turns>();
  turns.settle.mockImplementation(async (conversation) => conversation);
  posted = [];
  binding = undefined;
  app = await mount();
});

describe('creating, listing and reading conversations', () => {
  it('creates a conversation of the person\'s own, titled from what they said', async () => {
    const created = await app.post<Conversation>('/api/conversations', { title: 'My Custom Thread' });
    expect(created).toMatchObject({ status: 200, data: { ownerId: TEST_USER.id, title: 'My Custom Thread', messages: [] } });
    expect(await app.db.engine.getConversation(TEST_USER.id, created.data.id)).toMatchObject({ title: 'My Custom Thread' });
  });

  it('lists the person\'s conversations newest first with how many messages each holds, and none of anyone else\'s', async () => {
    await app.db.engine.saveConversation(chat({ id: 'old', updatedAt: '2026-01-01', messages: [{ role: 'user', content: 'hi' } as Conversation['messages'][number]] }));
    await app.db.engine.saveConversation(chat({ id: 'new', updatedAt: '2026-02-01' }));
    await app.db.engine.saveConversation(chat({ id: 'theirs', ownerId: 'someone-else' }));
    const listed = await app.get<{ id: string; messageCount: number; messages?: unknown }[]>('/api/conversations');
    expect(listed.data.map((one) => [one.id, one.messageCount])).toEqual([['new', 0], ['old', 1]]);
    expect(listed.data[0]).not.toHaveProperty('messages');
  });

  it('reads one, settling a turn under way first, and says when it is not theirs', async () => {
    await app.db.engine.saveConversation(chat({ liveTurn: { runId: 'r1', startedAt: 'then' } }));
    turns.settle.mockImplementation(async (conversation) => ({ ...conversation, title: 'settled' }));
    expect(await app.get('/api/conversations/c1')).toMatchObject({ status: 200, data: { id: 'c1', title: 'settled' } });
    await app.db.engine.saveConversation(chat({ id: 'theirs', ownerId: 'someone-else' }));
    expect(await app.get('/api/conversations/theirs')).toMatchObject({ status: 404, data: { error: 'No such conversation' } });
  });

  it('reads one as it is where no turns are settled', async () => {
    const plain = await mount(['turns']);
    await plain.db.engine.saveConversation(chat());
    expect((await plain.get('/api/conversations/c1')).data).toMatchObject({ id: 'c1' });
  });

  it('names who wrote each message other than the viewer\'s when the conversation is in a shared project', async () => {
    await app.db.hub.saveHubLink({ projectId: 'p1', hubId: 'h1', members: [{ personId: 'm1', email: 'm1@example.com' }] } as never);
    await app.db.engine.saveConversation(chat({ messages: [{ role: 'user', content: 'from m1', at: 'x', author: { kind: 'person', id: 'm1' } } as Conversation['messages'][number]] }));
    const read = await app.get<{ messages: { authorName?: string }[] }>('/api/conversations/c1');
    expect(read.data.messages[0]?.authorName).toBe('m1@example.com');
  });
});

describe('a conversation bound to something', () => {
  it('binds to a tree the person owns, and refuses one they do not', async () => {
    await app.db.projects.saveTree({ id: 'mine', ownerId: TEST_USER.id, name: 'Mine', type: 'software', projectIds: [], createdAt: 'a', updatedAt: 'a' });
    await app.db.projects.saveTree({ id: 'theirs', ownerId: 'someone-else', name: 'Theirs', type: 'software', projectIds: [], createdAt: 'a', updatedAt: 'a' });
    expect(await app.post('/api/conversations', { title: 'Grow it', treeId: 'mine' })).toMatchObject({ status: 200, data: { treeId: 'mine' } });
    expect((await app.post('/api/conversations', { treeId: 'theirs' })).status).toBe(404);
    expect((await app.post('/api/conversations', { treeId: 'nowhere' })).status).toBe(404);
  });

  it('binds to a project the person owns, never to one they do not, and never to a tree and a project at once', async () => {
    await app.db.projects.saveProjectInfo({ id: 'p-mine', name: 'mine', ownerId: TEST_USER.id, appType: 'local', createdAt: 'now' } as never);
    await app.db.projects.saveProjectInfo({ id: 'p-theirs', name: 'theirs', ownerId: 'someone-else', appType: 'local', createdAt: 'now' } as never);
    expect(await app.post('/api/conversations', { projectId: 'p-mine' })).toMatchObject({ status: 200, data: { projectId: 'p-mine' } });
    expect((await app.post('/api/conversations', { projectId: 'p-theirs' })).status).toBe(404);
    expect(await app.post('/api/conversations', { projectId: 'p-mine', treeId: 'mine' })).toMatchObject({ status: 400, data: { error: 'A conversation is about a tree or a project, not both' } });
  });

  it('refuses a tree or a project where the router has no way to find the person\'s own', async () => {
    const bare = await mount(['ownedTrees', 'ownedProjects']);
    expect((await bare.post('/api/conversations', { treeId: 't' })).status).toBe(404);
    expect((await bare.post('/api/conversations', { projectId: 'p' })).status).toBe(404);
  });
});

describe('posting in a channel', () => {
  it('posts a message the person wrote, tells the process it landed, and answers 201', async () => {
    await app.db.engine.saveConversation(chat({ kind: 'channel' }));
    const sent = await app.post<{ message: { content: string } }>('/api/conversations/c1/messages', { content: 'ship it' });
    expect(sent).toMatchObject({ status: 201, data: { message: { content: 'ship it' } } });
    expect(posted).toEqual([`${TEST_USER.id}/c1`]);
    expect((await app.db.engine.getConversation(TEST_USER.id, 'c1'))?.messages).toHaveLength(1);
  });

  it('refuses a conversation that is not a channel, one that is not theirs, and a message with nothing in it', async () => {
    await app.db.engine.saveConversation(chat());
    expect(await app.post('/api/conversations/c1/messages', { content: 'hi' })).toMatchObject({ status: 409 });
    await app.db.engine.saveConversation(chat({ id: 'ch', kind: 'channel' }));
    expect((await app.post('/api/conversations/ch/messages', { content: '  ' })).status).toBe(400);
    await app.db.engine.saveConversation(chat({ id: 'theirs', ownerId: 'someone-else', kind: 'channel' }));
    expect((await app.post('/api/conversations/theirs/messages', { content: 'hi' })).status).toBe(404);
    expect(posted).toEqual([]);
  });

  it('refuses an attachment from a project that is not theirs', async () => {
    await app.db.engine.saveConversation(chat({ kind: 'channel' }));
    const refused = await app.post('/api/conversations/c1/messages', { content: 'see', attachments: [{ projectId: 'nope', path: 'a.md', name: 'a.md', size: 1, type: 'text/plain' }] });
    expect(refused).toMatchObject({ status: 400, data: { error: 'nope is not one of your projects' } });
  });
});

describe('attaching files in a channel', () => {
  it('keeps an attachment from a project the person owns, named with the project', async () => {
    await app.db.engine.saveConversation(chat({ kind: 'channel' }));
    await app.db.projects.saveProjectInfo({ id: 'p-mine', name: 'Shop', ownerId: TEST_USER.id, appType: 'local', createdAt: 'now' } as never);
    const sent = await app.post<{ message: { attachments?: unknown[] } }>('/api/conversations/c1/messages', { content: 'see', attachments: [{ projectId: 'p-mine', path: 'docs/a.md', name: 'a.md', size: 1, type: 'text/markdown' }] });
    expect(sent).toMatchObject({ status: 201, data: { message: { attachments: [{ name: 'a.md', path: 'docs/a.md', project: { id: 'p-mine', name: 'Shop' } }] } } });
  });
});

describe('deleting a conversation', () => {
  it('saves its workspace first, then deletes it', async () => {
    await app.db.engine.saveConversation(chat());
    expect(await app.delete('/api/conversations/c1')).toMatchObject({ status: 200, data: { success: true } });
    expect(workspaces.conclude).toHaveBeenCalledWith(TEST_USER.id, 'c1');
    expect(await app.db.engine.getConversation(TEST_USER.id, 'c1')).toBeUndefined();
  });

  it('keeps the conversation when its workspace could not be saved', async () => {
    await app.db.engine.saveConversation(chat());
    workspaces.conclude.mockRejectedValue(new Error('Pushing to koala-u1/research-x failed: Gitea is down'));
    expect(await app.delete('/api/conversations/c1')).toMatchObject({ status: 500, data: { error: 'Pushing to koala-u1/research-x failed: Gitea is down' } });
    expect(await app.db.engine.getConversation(TEST_USER.id, 'c1')).toBeDefined();
  });

  it('says when it is not theirs', async () => {
    await app.db.engine.saveConversation(chat({ id: 'theirs', ownerId: 'someone-else' }));
    expect((await app.delete('/api/conversations/theirs')).status).toBe(404);
    expect(workspaces.conclude).not.toHaveBeenCalled();
  });
});

describe('the picks a chat keeps', () => {
  it('patches the pinned model and agent, strips them with null, and rejects an empty patch', async () => {
    await app.db.engine.saveConversation(chat());
    const patched = await app.patch<Conversation>('/api/conversations/c1', { modelId: 'heron-70b', agentSlug: 'heron', modelReach: 'chat' });
    expect(patched.data).toMatchObject({ modelId: 'heron-70b', agentSlug: 'heron', modelReach: 'chat' });
    expect(await app.db.engine.getConversation(TEST_USER.id, 'c1')).toMatchObject({ modelId: 'heron-70b', agentSlug: 'heron' });

    const cleared = await app.patch<Record<string, unknown>>('/api/conversations/c1', { modelId: null, agentSlug: null, modelReach: null });
    expect(cleared.data).not.toHaveProperty('modelId');
    expect(cleared.data).not.toHaveProperty('agentSlug');
    expect(cleared.data).not.toHaveProperty('modelReach');
    expect(await app.patch('/api/conversations/c1', {})).toMatchObject({ status: 400, data: { error: 'Nothing to update' } });
    expect((await app.patch('/api/conversations/c1', { modelReach: 'everyone' })).status).toBe(400);
  });

  it('hides a conversation that is not theirs or not there', async () => {
    await app.db.engine.saveConversation(chat({ id: 'theirs', ownerId: 'someone-else' }));
    expect((await app.patch('/api/conversations/theirs', { modelId: 'x' })).status).toBe(404);
    expect((await app.patch('/api/conversations/never', { modelId: 'x' })).status).toBe(404);
  });
});

describe('what Koala sees in a conversation, and its workspace', () => {
  it('shows what Koala is handed on each message, formatted, for a conversation bound to something', async () => {
    await app.db.engine.saveConversation(chat());
    binding = { projectId: 'p1', project: 'Project "Bare" (p1)' };
    const context = await app.get<{ given: Record<string, string>; text: string }>('/api/conversations/c1/context');
    expect(context).toMatchObject({ status: 200, data: { given: binding, text: 'projectId: p1\n\nproject: Project "Bare" (p1)' } });
  });

  it('shows nothing for a conversation bound to nothing, and hides one that is not theirs', async () => {
    await app.db.engine.saveConversation(chat());
    await app.db.engine.saveConversation(chat({ id: 'theirs', ownerId: 'someone-else' }));
    expect((await app.get('/api/conversations/c1/context')).data).toEqual({ given: {}, text: '' });
    expect((await app.get('/api/conversations/theirs/context')).status).toBe(404);
    expect((await app.get('/api/conversations/nope/context')).status).toBe(404);
  });

  it('says whether its workspace is running or parked', async () => {
    await app.db.engine.saveConversation(chat());
    workspaces.state.mockResolvedValue('parked');
    expect(await app.get('/api/conversations/c1/workspace')).toMatchObject({ status: 200, data: { state: 'parked' } });
    expect((await app.get('/api/conversations/nope/workspace')).status).toBe(404);
  });

  it('says it keeps no workspaces where the router has no way to ask', async () => {
    const bare = await mount(['workspaces']);
    await bare.db.engine.saveConversation(chat());
    expect(await bare.get('/api/conversations/c1/workspace')).toMatchObject({ status: 404, data: { error: 'This server keeps no conversation workspaces' } });
    expect((await bare.delete('/api/conversations/c1')).status).toBe(200);
  });
});
