import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { KoalasCluster } from './sandboxes/kube.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { createEngineHost, storesFromDatabase } from './host.js';
import { runsFingerprint, type McpServerRecord, type ServerRuns } from '../engine/lib/mcp-servers.js';
import { seedAll } from '../scripts/seed-all.js';
import { testKeys } from '../platform/testing/keys.js';

const HOSTED: ServerRuns = { where: 'hosted', url: 'http://127.0.0.1:1/mcp' };
const GITEA: McpServerRecord = {
  id: 'd1', ownerId: 'bo', name: 'gitea', runs: HOSTED, createdAt: 't0', updatedAt: 't0',
  captured: { tools: [{ name: 'list_repos', description: 'List repositories', annotations: { readOnlyHint: true } }], at: 't1', fingerprint: runsFingerprint(HOSTED) },
};

const hostFor = async (enabled: string[]) => {
  const db = await testDatabase();
  await seedAll(db, testKeys('mcp-on-host').data);
  await db.engine.saveMcpServer(GITEA);
  await db.engine.saveConversation({ id: 'c1', ownerId: 'bo', title: 'chat', messages: [], mcpServers: enabled, createdAt: 't0', updatedAt: 't0' });
  const host = createEngineHost({ models: {} as never, cluster: mock<KoalasCluster>(), registry: { none: 'this test builds no workspace images' }, stores: storesFromDatabase(db), mcpHostedUrl: async () => undefined });
  const call = (name: string, args: Record<string, unknown>) => host.tools.run({ ticket: { runId: 'r1', depth: 0, ownerId: 'bo', agentSlug: 'koala', trigger: 'user', conversationId: 'c1' }, nodeId: 'n', name, arguments: JSON.stringify(args) }, 1);
  return { db, call };
};

describe('the person\'s MCP servers, read from their records by the engine host', () => {
  it('lets Koala ask to switch one on for the conversation, and keeps the request', async () => {
    const { db, call } = await hostFor([]);
    expect(await call('enable_mcp_server', { server: 'gitea', why: 'to read the repo' })).toMatchObject({ ok: true, content: 'Asked the person to switch gitea on for this conversation. Its tools arrive on the next turn if they agree.' });
    expect((await db.engine.getMcpRequests('bo', 'c1')).map((request) => [request.server, request.status])).toEqual([['gitea', 'requested']]);
  });

  it('offers a switched-on server\'s tools to the conversation, and says why a hosted one it cannot find the address of did not answer', async () => {
    const { call } = await hostFor(['gitea']);
    const answered = await call('gitea__list_repos', {});
    expect(answered.ok).toBe(false);
    expect(answered.content).toBe('the server has no address this platform can reach: its deployment is not running, or nothing routes to it');
  });
});
