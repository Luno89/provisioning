import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { mcpRouter } from './mcp.js';
import { McpService } from '../services/McpService.js';
import { withHints } from '../lib/mcp-tool-hints.js';

const post = (url: string, body: unknown = {}) => axios.post(url, body, { validateStatus: () => true });
const put = (url: string, body: unknown) => axios.put(url, body, { validateStatus: () => true });

describe('/api/mcp', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await mountRouter({
      prefix: '/api/mcp',
      router: (db) => mcpRouter({
        mcp: new McpService({
          store: db,
          servers: async () => withHints(
            [{ id: 'd1', name: 'Gitea MCP', url: 'u', tools: [{ name: 'list_repos', annotations: { readOnlyHint: true } }, { name: 'create_issue' }] }],
            await db.getMcpToolHints(TEST_USER.id),
          ),
        }),
      }),
    });
    await harness.db.saveConversation({ id: 'c1', ownerId: TEST_USER.id, title: 't', messages: [], createdAt: 'x', updatedAt: 'x' });
    await harness.db.saveMcpRequest({ id: 'q1', ownerId: TEST_USER.id, conversationId: 'c1', server: 'Gitea MCP', why: 'read the repo', status: 'requested', createdAt: 'x', updatedAt: 'x' });
  });

  afterEach(() => harness.close());

  it('lists the person\'s servers with their tools', async () => {
    const res = await axios.get(harness.url('/api/mcp/servers'));
    expect(res.data).toEqual([{ name: 'Gitea MCP', tools: [
      { name: 'list_repos', readOnly: true, kind: 'read-only', declared: 'read-only', choice: 'server' },
      { name: 'create_issue', readOnly: false, kind: 'destructive', declared: 'destructive', choice: 'server' },
    ] }]);
  });

  it('lets the person say what a tool the server does not describe really does, and back again', async () => {
    const set = await put(harness.url('/api/mcp/servers/Gitea%20MCP/tools/create_issue/hint'), { choice: 'safe-write' });
    expect(set.status).toBe(200);
    expect(set.data[0].tools[1]).toEqual({ name: 'create_issue', readOnly: false, kind: 'safe-write', declared: 'destructive', choice: 'safe-write' });

    const back = await put(harness.url('/api/mcp/servers/Gitea%20MCP/tools/create_issue/hint'), { choice: 'server' });
    expect(back.data[0].tools[1]).toMatchObject({ kind: 'destructive', choice: 'server' });
    expect(await harness.db.getMcpToolHints(TEST_USER.id)).toEqual([]);
  });

  it('refuses a choice it does not know and a tool the server does not offer', async () => {
    expect((await put(harness.url('/api/mcp/servers/Gitea%20MCP/tools/create_issue/hint'), { choice: 'harmless' })).status).toBe(400);
    expect((await put(harness.url('/api/mcp/servers/Gitea%20MCP/tools/drop_tables/hint'), { choice: 'read-only' })).status).toBe(404);
  });

  it('enabling a request switches the server on for its conversation, once', async () => {
    const res = await post(harness.url('/api/mcp/requests/q1/enable'));
    expect(res.status).toBe(200);
    expect(res.data.request.status).toBe('enabled');
    expect((await harness.db.getConversation(TEST_USER.id, 'c1'))?.mcpServers).toEqual(['Gitea MCP']);
    expect((await post(harness.url('/api/mcp/requests/q1/enable'))).status).toBe(409);
  });

  it('dismissing leaves the conversation alone', async () => {
    expect((await post(harness.url('/api/mcp/requests/q1/dismiss'))).data.request.status).toBe('dismissed');
    expect((await harness.db.getConversation(TEST_USER.id, 'c1'))?.mcpServers).toBeUndefined();
  });

  it('sets a conversation\'s servers, refusing one the person does not run', async () => {
    expect((await put(harness.url('/api/mcp/conversations/c1/servers'), { servers: ['Gitea MCP'] })).data.conversation.mcpServers).toEqual(['Gitea MCP']);
    const refused = await put(harness.url('/api/mcp/conversations/c1/servers'), { servers: ['Jira'] });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toContain('Jira');
    expect((await put(harness.url('/api/mcp/conversations/nope/servers'), { servers: [] })).status).toBe(404);
  });
});
