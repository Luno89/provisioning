import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { KoalasCluster } from './sandboxes/kube.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { createEngineHost, storesFromDatabase } from './host.js';
import { runsFingerprint, type McpServerRecord, type ServerRuns } from '../engine/lib/mcp-servers.js';
import { seedAll } from '../scripts/seed-all.js';
import { grantHeld, grantsHeldInMemory, hostGrants } from '../engine/testing/run-grants.js';

const noMemoryIndex = async (): Promise<void> => { throw new Error('nothing here keeps a memory index'); };

const HOSTED: ServerRuns = { where: 'hosted', url: 'http://127.0.0.1:1/mcp' };
const GITEA: McpServerRecord = {
  id: 'd1', ownerId: 'bo', name: 'gitea', runs: HOSTED, createdAt: 't0', updatedAt: 't0',
  captured: { tools: [{ name: 'list_repos', description: 'List repositories', annotations: { readOnlyHint: true } }], at: 't1', fingerprint: runsFingerprint(HOSTED) },
};

const SAID_READ_ONLY: McpServerRecord = { ...GITEA, tools: { list_repos: { kind: 'read-only' } } };

const hostFor = async (enabled: string[], server: McpServerRecord = SAID_READ_ONLY) => {
  const db = await testDatabase();
  await seedAll(db);
  await db.engine.saveMcpServer(server);
  await db.engine.saveConversation({ id: 'c1', ownerId: 'bo', title: 'chat', messages: [], mcpServers: enabled, createdAt: 't0', updatedAt: 't0' });
  const grants = grantsHeldInMemory();
    const grantId = await grantHeld(grants, { ownerId: 'bo', runId: 'r1' });
    const host = createEngineHost({ runGrants: hostGrants(grants), models: {} as never, cluster: mock<KoalasCluster>(), registry: { none: 'this test builds no workspace images' }, revokeRegistryPushToken: async () => undefined, stores: storesFromDatabase(db, noMemoryIndex), mcpHostedUrl: async () => undefined });
  const call = (name: string, args: Record<string, unknown>) => host.tools.run({ ticket: { runId: 'r1', depth: 0, ownerId: 'bo', grantId, agentSlug: 'koala', trigger: 'user', conversationId: 'c1' }, nodeId: 'n', name, arguments: JSON.stringify(args) }, 1);
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

  it('asks the person before a hosted server\'s tool runs while only the server itself says it only reads', async () => {
    const { call } = await hostFor(['gitea'], GITEA);
    expect(await call('gitea__list_repos', {})).toMatchObject({ ok: false, asks: true, digest: 'gitea__list_repos waits for a person to allow it' });
  });

  it('lists the person\'s servers with their state, and the known ones they have not added', async () => {
    const { call } = await hostFor([]);
    const listed = await call('list_mcp_servers', {});
    expect(listed.ok).toBe(true);
    expect(listed.content).toContain('gitea');
    expect(listed.content).toContain('playwright');
  });

  it('puts a proposal to add a known server on a card in the conversation, once, kept with the person\'s records', async () => {
    const { db, call } = await hostFor([]);
    const proposed = await call('propose_mcp_server', { template: 'playwright', why: 'to check pages in a browser', agents: ['executor'] });
    expect(proposed.ok, proposed.content).toBe(true);
    expect((await call('propose_mcp_server', { template: 'playwright', why: 'to check pages in a browser', agents: ['executor'] })).content).toMatch(/^This is already waiting for the person on a card/);
    const cards = (await db.engine.getActionProposals('bo')).filter((proposal) => proposal.kind === 'add_mcp_server');
    expect(cards.map((card) => [card.conversationId, card.status])).toEqual([['c1', 'proposed']]);
  });
});

