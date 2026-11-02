import { beforeEach, describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { runsFingerprint, type McpServerRecord } from '../lib/mcp-servers.js';
import { McpService } from './McpService.js';

const OWNER = 'u1';
const HOSTED = { where: 'hosted' as const, url: 'http://gitea.test/mcp' };

let db: Database;
let service: McpService;

const gitea: McpServerRecord = {
  id: 'd1', ownerId: OWNER, name: 'gitea', runs: HOSTED, createdAt: 'x', updatedAt: 'x',
  tools: { create_issue: { kind: 'safe-write' } },
  captured: { tools: [{ name: 'list_repos', annotations: { readOnlyHint: true } }, { name: 'create_issue', description: 'Opens an issue.' }], at: 'x', fingerprint: runsFingerprint(HOSTED) },
};

beforeEach(async () => {
  db = memoryDatabase();
  service = new McpService({ store: db.engine, catalogue: (ownerId) => db.engine.getMcpServers(ownerId), now: () => 'now' });
  await db.engine.saveMcpServer(gitea);
  await db.engine.saveMcpServer({ id: 'd2', ownerId: OWNER, name: 'uncaptured', runs: { where: 'hosted', url: 'http://other.test/mcp' }, createdAt: 'x', updatedAt: 'x' });
  await db.engine.saveMcpServer({ id: 'd3', ownerId: OWNER, name: 'local', runs: { where: 'workspace', needs: [], start: 'x', port: 1 }, createdAt: 'x', updatedAt: 'x' });
  await db.engine.saveConversation({ id: 'c1', ownerId: OWNER, title: 't', messages: [], createdAt: 'x', updatedAt: 'x' });
  await db.engine.saveMcpRequest({ id: 'q1', ownerId: OWNER, conversationId: 'c1', server: 'gitea', why: 'read the repo', status: 'requested', createdAt: 'x', updatedAt: 'x' });
});

describe('the MCP servers a conversation can switch on', () => {
  it('lists the person\'s captured hosted servers with their tools and what each does, a server\'s own word only beside what the person said', async () => {
    expect(await service.servers(OWNER)).toEqual([{ name: 'gitea', tools: [
      { name: 'list_repos', readOnly: false, kind: 'destructive', declared: 'read-only' },
      { name: 'create_issue', description: 'Opens an issue.', readOnly: false, kind: 'safe-write', declared: 'destructive' },
    ] }]);
  });

  it('names the same servers, and none of another person\'s', async () => {
    expect(await service.serverNames(OWNER)).toEqual(['gitea']);
    expect(await service.serverNames('u2')).toEqual([]);
  });

  it('lists the requests for servers, all of them or one conversation\'s', async () => {
    await db.engine.saveMcpRequest({ id: 'q2', ownerId: OWNER, conversationId: 'c2', server: 'gitea', why: 'again', status: 'requested', createdAt: 'x', updatedAt: 'x' });
    expect((await service.requests(OWNER)).map((request) => request.id).sort()).toEqual(['q1', 'q2']);
    expect((await service.requests(OWNER, 'c1')).map((request) => request.id)).toEqual(['q1']);
  });
});

describe('a request for a server', () => {
  it('switches the server on for its conversation when enabled, once', async () => {
    const enabled = await service.enable(OWNER, 'q1');
    expect(enabled).toMatchObject({ ok: true, request: { status: 'enabled', updatedAt: 'now' }, conversation: { mcpServers: ['gitea'] } });
    expect((await db.engine.getConversation(OWNER, 'c1'))?.mcpServers).toEqual(['gitea']);
    expect(await service.enable(OWNER, 'q1')).toEqual({ ok: false, status: 409, error: 'This request is already enabled.' });
  });

  it('keeps the servers a conversation already has when it adds one', async () => {
    await db.engine.saveConversation({ id: 'c1', ownerId: OWNER, title: 't', messages: [], mcpServers: ['docs', 'gitea'], createdAt: 'x', updatedAt: 'x' });
    const enabled = await service.enable(OWNER, 'q1');
    expect(enabled.ok && enabled.conversation?.mcpServers).toEqual(['docs', 'gitea']);
  });

  it('refuses a request that is not there, whose conversation is gone, or whose server stopped running', async () => {
    expect(await service.enable(OWNER, 'nope')).toEqual({ ok: false, status: 404, error: 'Request not found' });
    expect(await service.dismiss(OWNER, 'nope')).toEqual({ ok: false, status: 404, error: 'Request not found' });
    await db.engine.saveMcpRequest({ id: 'q2', ownerId: OWNER, conversationId: 'gone', server: 'gitea', why: 'x', status: 'requested', createdAt: 'x', updatedAt: 'x' });
    expect(await service.enable(OWNER, 'q2')).toEqual({ ok: false, status: 404, error: 'The conversation this was asked in no longer exists' });
    await db.engine.saveMcpRequest({ id: 'q3', ownerId: OWNER, conversationId: 'c1', server: 'retired', why: 'x', status: 'requested', createdAt: 'x', updatedAt: 'x' });
    expect(await service.enable(OWNER, 'q3')).toEqual({ ok: false, status: 409, error: 'retired is no longer running' });
  });

  it('is dismissed without touching the conversation', async () => {
    expect(await service.dismiss(OWNER, 'q1')).toMatchObject({ ok: true, request: { status: 'dismissed' } });
    expect((await db.engine.getConversation(OWNER, 'c1'))?.mcpServers).toBeUndefined();
    expect(await service.dismiss(OWNER, 'q1')).toMatchObject({ ok: false, status: 409 });
  });
});

describe('the servers a conversation holds', () => {
  it('sets them once each, refusing one the person does not run', async () => {
    expect(await service.setConversationServers(OWNER, 'c1', ['gitea', 'gitea'])).toMatchObject({ ok: true, conversation: { mcpServers: ['gitea'], updatedAt: 'now' } });
    expect(await service.setConversationServers(OWNER, 'c1', ['uncaptured'])).toMatchObject({ ok: false, status: 400 });
    expect(await service.setConversationServers(OWNER, 'c1', ['local'])).toMatchObject({ ok: false, status: 400 });
    expect(await service.setConversationServers(OWNER, 'c1', ['Jira'])).toEqual({ ok: false, status: 400, error: 'not one of your MCP servers: Jira' });
    expect(await service.setConversationServers(OWNER, 'nope', [])).toEqual({ ok: false, status: 404, error: 'No such conversation' });
  });

  it('takes only a list of names', async () => {
    expect(await service.setConversationServers(OWNER, 'c1', 'gitea')).toEqual({ ok: false, status: 400, error: 'servers has to be a list of server names' });
    expect(await service.setConversationServers(OWNER, 'c1', [1])).toMatchObject({ ok: false, status: 400 });
  });

  it('clears them with an empty list', async () => {
    await service.setConversationServers(OWNER, 'c1', ['gitea']);
    expect(await service.setConversationServers(OWNER, 'c1', [])).toMatchObject({ ok: true, conversation: { mcpServers: [] } });
  });
});
