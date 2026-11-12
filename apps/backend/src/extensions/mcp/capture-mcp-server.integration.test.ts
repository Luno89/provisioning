import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILT_IN_GROUPS, HOST_OP_KIND, WORKFLOW_IMPLEMENTATIONS, runProcedure, type NodeExecutor, type NodeImplementation } from '@koala/agent-engine/procedure';
import { testDatabase } from '../../platform/lib/test-database.js';
import { storesFromDatabase } from '../../engine-host/host.js';
import { runsFingerprint, type McpServerRecord } from '../../engine/lib/mcp-servers.js';
import { platformCatalogue } from '../installed.js';
import { createMcpOperations } from './operations/handlers.js';
import { CAPTURE_MCP_SERVER } from './procedures.js';

const TOOLS = [{ name: 'list_repos', description: 'List repositories', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];
let server: http.Server;
let url = '';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      const call = JSON.parse(body) as { id?: number; method: string };
      const result = call.method === 'initialize'
        ? { protocolVersion: '2025-06-18', serverInfo: { name: 'Gitea MCP', version: '1' }, instructions: 'List before you open.', capabilities: { tools: {} } }
        : call.method === 'tools/list' ? { tools: TOOLS } : undefined;
      response.writeHead(result || call.id === undefined ? 200 : 400, { 'content-type': 'application/json' });
      response.end(call.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => { await new Promise<void>((done) => server.close(() => done())); });

const nothingToBuild = async (): Promise<never> => { throw new Error('a hosted server is neither built nor started'); };

async function captured(reachable: boolean) {
  const db = await testDatabase();
  const stores = storesFromDatabase(db);
  const record: McpServerRecord = { id: 's1', ownerId: 'bo', name: 'gitea', runs: { where: 'hosted', url }, capturing: { runId: 'mcp-capture-s1', at: 't0' }, createdAt: 't0', updatedAt: 't0' };
  await stores.mcpServers!.save(record);
  const operations = createMcpOperations({
    servers: stores.mcpServers!,
    hostedUrl: async () => (reachable ? url : undefined),
    plan: nothingToBuild,
    images: { ensure: nothingToBuild },
    environments: { forRun: nothingToBuild, release: async () => undefined },
    now: () => '2026-11-11T12:00:00Z',
  });
  const local = new Map<string, NodeImplementation>(WORKFLOW_IMPLEMENTATIONS.map((implementation) => [implementation.kind, implementation] as const));
  const executor: NodeExecutor = {
    async step(request) {
      if (request.node.kind === HOST_OP_KIND) return operations[String(request.node.settings.operation)]!(request);
      const implementation = local.get(request.node.kind);
      if (implementation?.role !== 'step') throw new Error(`no step for ${request.node.kind}`);
      return implementation.run(request) as never;
    },
    async value(request) {
      const implementation = local.get(request.node.kind);
      if (implementation?.role !== 'value') throw new Error(`no value for ${request.node.kind}`);
      return implementation.run(request) as never;
    },
  };
  const outcome = await runProcedure({
    procedure: CAPTURE_MCP_SERVER, catalogue: platformCatalogue(), groups: BUILT_IN_GROUPS, executor,
    identity: { runId: 'mcp-capture-s1', depth: 0, agentId: 'mcp-capture', loopId: 'capture-mcp-server', loopVersion: '1', trigger: 'user' },
    launch: { ownerId: 'bo' }, inputs: { serverId: 's1' }, bus: { emit: () => undefined, subscribe: () => () => undefined } as never,
  });
  return { outcome, kept: await stores.mcpServers!.get('bo', 's1') };
}

describe('capturing the person\'s hosted MCP server into their own records', () => {
  it('keeps what the server says about itself and its tools on the record, and it is no longer being captured', async () => {
    const { outcome, kept } = await captured(true);
    expect(outcome).toMatchObject({ outcome: 'ok' });
    expect(kept?.captured).toEqual({ instructions: 'List before you open.', serverInfo: { name: 'Gitea MCP', version: '1' }, tools: TOOLS, at: '2026-11-11T12:00:00Z', fingerprint: runsFingerprint({ where: 'hosted', url }) });
    expect(kept?.capturing).toBeUndefined();
  });

  it('keeps why the server could not be reached, so it is offered to no one', async () => {
    const { outcome, kept } = await captured(false);
    expect(outcome).toMatchObject({ outcome: 'failed' });
    expect(kept?.failed?.why).toMatch(/gitea has no address this server can reach/);
    expect(kept?.captured).toBeUndefined();
  });
});
