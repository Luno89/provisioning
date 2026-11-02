import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { McpRequest } from '@koala/harness-types';
import type { McpServerService, McpServerView } from '../services/McpServerService.js';
import type { McpService } from '../services/McpService.js';
import { mountInProcess, PERSON, type InProcess } from '../testing/in-process.js';
import { mcpRouter } from './mcp.js';

const view: McpServerView = { id: 's1', ownerId: PERSON.id, name: 'playwright', runs: { where: 'hosted', url: 'http://x.test/mcp' }, createdAt: 't', updatedAt: 't', status: { state: 'capturing', runId: 'c1' } };
const request: McpRequest = { id: 'q1', ownerId: PERSON.id, conversationId: 'c1', server: 'gitea', why: 'read the repo', status: 'requested', createdAt: 'x', updatedAt: 'x' };

let mcp: ReturnType<typeof mock<McpService>>;
let catalogue: ReturnType<typeof mock<McpServerService>>;
let app: InProcess;

beforeEach(async () => {
  mcp = mock<McpService>();
  catalogue = mock<McpServerService>();
  app = await mountInProcess({ prefix: '/api/mcp', router: () => mcpRouter({ mcp, catalogue }) });
});

describe('/api/mcp servers and requests', () => {
  it('lists the servers a conversation can switch on', async () => {
    mcp.servers.calledWith(PERSON.id).mockResolvedValue([{ name: 'gitea', tools: [] }]);
    expect(await app.get('/api/mcp/servers')).toMatchObject({ status: 200, data: [{ name: 'gitea' }] });
  });

  it('lists the requests, all of them or one conversation\'s', async () => {
    mcp.requests.mockResolvedValue([request]);
    expect(await app.get('/api/mcp/requests')).toMatchObject({ status: 200, data: [{ id: 'q1' }] });
    expect(mcp.requests).toHaveBeenLastCalledWith(PERSON.id, undefined);
    await app.get('/api/mcp/requests?conversationId=c1');
    expect(mcp.requests).toHaveBeenLastCalledWith(PERSON.id, 'c1');
  });

  it('answers an enabled request with the request and its conversation', async () => {
    mcp.enable.calledWith(PERSON.id, 'q1').mockResolvedValue({ ok: true, request: { ...request, status: 'enabled' }, conversation: { id: 'c1', ownerId: PERSON.id, title: 't', messages: [], mcpServers: ['gitea'], createdAt: 'x', updatedAt: 'x' } });
    expect(await app.post('/api/mcp/requests/q1/enable')).toMatchObject({ status: 200, data: { request: { status: 'enabled' }, conversation: { mcpServers: ['gitea'] } } });
  });

  it('answers a dismissed request with the request alone', async () => {
    mcp.dismiss.calledWith(PERSON.id, 'q1').mockResolvedValue({ ok: true, request: { ...request, status: 'dismissed' } });
    const dismissed = await app.post<Record<string, unknown>>('/api/mcp/requests/q1/dismiss');
    expect(dismissed).toMatchObject({ status: 200, data: { request: { status: 'dismissed' } } });
    expect(dismissed.data).not.toHaveProperty('conversation');
  });

  it('answers a request already decided, or not there, with the service\'s status and words', async () => {
    mcp.enable.mockResolvedValueOnce({ ok: false, status: 409, error: 'This request is already enabled.' });
    mcp.dismiss.mockResolvedValueOnce({ ok: false, status: 404, error: 'Request not found' });
    expect(await app.post('/api/mcp/requests/q1/enable')).toMatchObject({ status: 409, data: { error: 'This request is already enabled.' } });
    expect(await app.post('/api/mcp/requests/nope/dismiss')).toMatchObject({ status: 404, data: { error: 'Request not found' } });
  });

  it('sets the servers a conversation holds from the list in the body', async () => {
    mcp.setConversationServers.mockResolvedValue({ ok: true, conversation: { id: 'c1', ownerId: PERSON.id, title: 't', messages: [], mcpServers: ['gitea'], createdAt: 'x', updatedAt: 'x' } });
    expect(await app.put('/api/mcp/conversations/c1/servers', { servers: ['gitea'] })).toMatchObject({ status: 200, data: { conversation: { mcpServers: ['gitea'] } } });
    expect(mcp.setConversationServers).toHaveBeenCalledWith(PERSON.id, 'c1', ['gitea']);
    mcp.setConversationServers.mockResolvedValue({ ok: false, status: 400, error: 'not one of your MCP servers: Jira' });
    expect(await app.put('/api/mcp/conversations/c1/servers', { servers: ['Jira'] })).toMatchObject({ status: 400, data: { error: 'not one of your MCP servers: Jira' } });
  });
});

describe('/api/mcp/catalogue', () => {
  it('lists the catalogue of servers and the known ones to add', async () => {
    catalogue.catalogue.calledWith(PERSON.id).mockResolvedValue({ servers: [view], templates: [] });
    expect(await app.get('/api/mcp/catalogue')).toMatchObject({ status: 200, data: { servers: [{ id: 's1' }], templates: [] } });
  });

  it('reads one server, and says when there is none', async () => {
    catalogue.get.calledWith(PERSON.id, 's1').mockResolvedValue(view);
    expect(await app.get('/api/mcp/catalogue/s1')).toMatchObject({ status: 200, data: { name: 'playwright' } });
    expect(await app.get('/api/mcp/catalogue/nope')).toMatchObject({ status: 404, data: { error: 'Server not found' } });
  });

  it('adds a server from the body with a 201, and answers a refusal with its status', async () => {
    catalogue.add.mockResolvedValueOnce({ ok: true, server: view });
    expect(await app.post('/api/mcp/catalogue', { template: 'playwright' })).toMatchObject({ status: 201, data: { name: 'playwright' } });
    expect(catalogue.add).toHaveBeenCalledWith(PERSON.id, { template: 'playwright' });
    catalogue.add.mockResolvedValueOnce({ ok: false, status: 409, error: 'a server is already called docs' });
    expect(await app.post('/api/mcp/catalogue', { name: 'docs' })).toMatchObject({ status: 409, data: { error: 'a server is already called docs' } });
  });

  it('saves a server from the body, and captures it again', async () => {
    catalogue.save.mockResolvedValue({ ok: true, server: { ...view, notes: 'Snapshot first.' } });
    expect(await app.put('/api/mcp/catalogue/s1', { notes: 'Snapshot first.' })).toMatchObject({ status: 200, data: { notes: 'Snapshot first.' } });
    expect(catalogue.save).toHaveBeenCalledWith(PERSON.id, 's1', { notes: 'Snapshot first.' });
    catalogue.recapture.mockResolvedValueOnce({ ok: false, status: 409, error: 'playwright is being captured already' });
    expect(await app.post('/api/mcp/catalogue/s1/capture')).toMatchObject({ status: 409, data: { error: 'playwright is being captured already' } });
    catalogue.recapture.mockResolvedValueOnce({ ok: true, server: view });
    expect(await app.post('/api/mcp/catalogue/s1/capture')).toMatchObject({ status: 200, data: { id: 's1' } });
  });

  it('removes a server, and says why it cannot', async () => {
    catalogue.remove.calledWith(PERSON.id, 's1').mockResolvedValue({ ok: true });
    catalogue.remove.calledWith(PERSON.id, 'theirs').mockResolvedValue({ ok: false, status: 404, error: 'Server not found' });
    expect(await app.delete('/api/mcp/catalogue/s1')).toMatchObject({ status: 200, data: { removed: true } });
    expect(await app.delete('/api/mcp/catalogue/theirs')).toMatchObject({ status: 404, data: { error: 'Server not found' } });
  });

  it('says it keeps no catalogue where none is wired, and still serves the rest', async () => {
    const bare = await mountInProcess({ prefix: '/api/mcp', router: () => mcpRouter({ mcp }) });
    const none = { status: 503, data: { error: 'This server keeps no catalogue of MCP servers' } };
    expect(await bare.get('/api/mcp/catalogue')).toMatchObject(none);
    expect(await bare.get('/api/mcp/catalogue/s1')).toMatchObject(none);
    expect(await bare.post('/api/mcp/catalogue', {})).toMatchObject(none);
    expect(await bare.put('/api/mcp/catalogue/s1', {})).toMatchObject(none);
    expect(await bare.post('/api/mcp/catalogue/s1/capture')).toMatchObject(none);
    expect(await bare.delete('/api/mcp/catalogue/s1')).toMatchObject(none);
    mcp.servers.mockResolvedValue([]);
    expect((await bare.get('/api/mcp/servers')).status).toBe(200);
  });
});
