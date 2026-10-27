import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { mcpRouter } from './mcp.js';
import { McpService } from '../services/McpService.js';
import { runsFingerprint } from '../lib/mcp-servers.js';
import { McpServerService } from '../services/McpServerService.js';
import { MCP_SERVER_TEMPLATES } from '../../extensions/mcp/templates.js';

const post = (url: string, body: unknown = {}) => axios.post(url, body, { validateStatus: () => true });
const put = (url: string, body: unknown) => axios.put(url, body, { validateStatus: () => true });

describe('/api/mcp', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await mountRouter({
      prefix: '/api/mcp',
      router: (db) => mcpRouter({
        mcp: new McpService({ store: db.engine, catalogue: (ownerId) => db.engine.getMcpServers(ownerId) }),
      }),
    });
    const runs = { where: 'hosted' as const, url: 'http://gitea.test/mcp' };
    await harness.db.engine.saveMcpServer({
      id: 'd1', ownerId: TEST_USER.id, name: 'gitea', runs, createdAt: 'x', updatedAt: 'x',
      tools: { create_issue: { kind: 'safe-write' } },
      captured: { tools: [{ name: 'list_repos', annotations: { readOnlyHint: true } }, { name: 'create_issue' }], at: 'x', fingerprint: runsFingerprint(runs) },
    });
    await harness.db.engine.saveMcpServer({ id: 'd2', ownerId: TEST_USER.id, name: 'uncaptured', runs: { where: 'hosted', url: 'http://other.test/mcp' }, createdAt: 'x', updatedAt: 'x' });
    await harness.db.engine.saveConversation({ id: 'c1', ownerId: TEST_USER.id, title: 't', messages: [], createdAt: 'x', updatedAt: 'x' });
    await harness.db.engine.saveMcpRequest({ id: 'q1', ownerId: TEST_USER.id, conversationId: 'c1', server: 'gitea', why: 'read the repo', status: 'requested', createdAt: 'x', updatedAt: 'x' });
  });

  afterEach(() => harness.close());

  it('lists the person\'s captured hosted servers with their tools and what each does, a server\'s own word only beside what the person said', async () => {
    const res = await axios.get(harness.url('/api/mcp/servers'));
    expect(res.data).toEqual([{ name: 'gitea', tools: [
      { name: 'list_repos', readOnly: false, kind: 'destructive', declared: 'read-only' },
      { name: 'create_issue', readOnly: false, kind: 'safe-write', declared: 'destructive' },
    ] }]);
  });

  it('enabling a request switches the server on for its conversation, once', async () => {
    const res = await post(harness.url('/api/mcp/requests/q1/enable'));
    expect(res.status).toBe(200);
    expect(res.data.request.status).toBe('enabled');
    expect((await harness.db.engine.getConversation(TEST_USER.id, 'c1'))?.mcpServers).toEqual(['gitea']);
    expect((await post(harness.url('/api/mcp/requests/q1/enable'))).status).toBe(409);
  });

  it('dismissing leaves the conversation alone', async () => {
    expect((await post(harness.url('/api/mcp/requests/q1/dismiss'))).data.request.status).toBe('dismissed');
    expect((await harness.db.engine.getConversation(TEST_USER.id, 'c1'))?.mcpServers).toBeUndefined();
  });

  it('sets a conversation\'s servers, refusing one the person does not run', async () => {
    expect((await put(harness.url('/api/mcp/conversations/c1/servers'), { servers: ['gitea'] })).data.conversation.mcpServers).toEqual(['gitea']);
    expect((await put(harness.url('/api/mcp/conversations/c1/servers'), { servers: ['uncaptured'] })).status).toBe(400);
    const refused = await put(harness.url('/api/mcp/conversations/c1/servers'), { servers: ['Jira'] });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toContain('Jira');
    expect((await put(harness.url('/api/mcp/conversations/nope/servers'), { servers: [] })).status).toBe(404);
  });
});

describe('/api/mcp/catalogue', () => {
  let harness: Harness;
  const started: string[] = [];

  beforeEach(async () => {
    started.length = 0;
    harness = await mountRouter({
      prefix: '/api/mcp',
      router: (db) => mcpRouter({
        mcp: new McpService({ store: db.engine, catalogue: async () => [] }),
        catalogue: new McpServerService({
          store: { list: (ownerId) => db.engine.getMcpServers(ownerId), save: (server) => db.engine.saveMcpServer(server), remove: (ownerId, id) => db.engine.deleteMcpServer(ownerId, id) },
          templates: () => MCP_SERVER_TEMPLATES,
          runs: { start: async (request) => { started.push(request.runId!); return { runId: request.runId!, agentSlug: request.agentSlug, loopId: 'capture-mcp-server' }; } },
          finished: async () => undefined,
          deployments: async () => [],
          names: async () => ({}),
        }),
      }),
    });
  });

  afterEach(() => harness.close());

  it('adds, reads, saves, captures again and removes a server, as its owner only', async () => {
    const added = await post(harness.url('/api/mcp/catalogue'), { template: 'playwright' });
    expect(added.status).toBe(201);
    expect(added.data).toMatchObject({ name: 'playwright', status: { state: 'capturing' } });
    const id = added.data.id as string;

    expect((await axios.get(harness.url('/api/mcp/catalogue'))).data).toMatchObject({ servers: [{ id, name: 'playwright' }], templates: [{ id: 'playwright', added: true }] });
    expect((await put(harness.url(`/api/mcp/catalogue/${id}`), { notes: 'Snapshot first.' })).data).toMatchObject({ notes: 'Snapshot first.' });
    expect((await post(harness.url(`/api/mcp/catalogue/${id}/capture`))).status).toBe(409);
    expect((await put(harness.url(`/api/mcp/catalogue/${id}`), { name: 'Bad Name' })).status).toBe(400);

    await harness.db.engine.saveMcpServer({ id: 'theirs', ownerId: 'someone-else', name: 'theirs', runs: { where: 'hosted', url: 'http://x.test/mcp' }, createdAt: 't', updatedAt: 't' });
    expect((await axios.get(harness.url('/api/mcp/catalogue/theirs'), { validateStatus: () => true })).status).toBe(404);
    expect((await axios.delete(harness.url('/api/mcp/catalogue/theirs'), { validateStatus: () => true })).status).toBe(404);

    expect((await axios.delete(harness.url(`/api/mcp/catalogue/${id}`))).data).toEqual({ removed: true });
    expect((await axios.get(harness.url('/api/mcp/catalogue'))).data.servers).toEqual([]);
    expect(started).toHaveLength(1);
  });
});
