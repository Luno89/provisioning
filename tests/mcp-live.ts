import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios, { type AxiosInstance } from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { slugify } from '../apps/backend/src/lib/mcp-tools.js';

const BASE = process.env.MCP_LIVE_URL ?? 'http://localhost:3001/api';
const LIMIT_MS = 8 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + LIMIT_MS;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(3_000);
  }
}

interface Trace { finish?: unknown; outputs?: { results?: { name: string; ok: boolean }[] } }

async function finished(http: AxiosInstance, runId: string): Promise<Trace[]> {
  return until(`run ${runId} to finish`, async () => {
    const traces = (await http.get(`/engine/runs/${runId}/traces`)).data.traces as Trace[];
    return traces.some((trace) => trace.finish !== undefined) ? traces : undefined;
  });
}

const called = (traces: Trace[], prefix: string) => traces
  .flatMap((trace) => trace.outputs?.results ?? [])
  .filter((result) => result.name.startsWith(prefix));

async function turn(http: AxiosInstance, agent: string, message: string, conversationId?: string): Promise<Trace[]> {
  const body = conversationId ? { agent, message, conversationId, inputs: { conversationId } } : { agent, message };
  const { runId } = (await http.post('/engine/runs', body)).data as { runId: string };
  console.log(`  ${agent} run ${runId}`);
  return finished(http, runId);
}

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const ownerId = (await db.getDeployments()).find((dep) => dep.appType === 'gitapp' && dep.status === 'running' && dep.ownerId)?.ownerId;
  assert.ok(ownerId, 'nobody runs an MCP server here');
  const user = await db.getUserById(ownerId);
  assert.ok(user);
  const secret = process.env.JWT_SECRET;
  assert.ok(secret, 'JWT_SECRET is not set');
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, secret, 3600)}` } });

  const servers = (await http.get('/mcp/servers')).data as { name: string; tools: { name: string }[]; unreachable?: string }[];
  const server = servers.find((candidate) => !candidate.unreachable && candidate.tools.some((tool) => tool.name.startsWith('list_')));
  assert.ok(server, 'no MCP server is answering with a list tool');
  const prefix = `${slugify(server.name)}__`;
  console.log(`server ${server.name}: ${server.tools.length} tools`);

  const conversations: string[] = [];
  const persona = `mcp-live-${Date.now().toString(36)}`;
  try {
    const switched = (await http.post('/conversations', {})).data.id as string;
    conversations.push(switched);
    await http.put(`/mcp/conversations/${switched}/servers`, { servers: [server.name] });
    const used = called(await turn(http, 'koala', `Using ${server.name}, list my repositories. Just the names.`, switched), prefix);
    assert.ok(used.some((result) => result.ok), `koala called no ${prefix} tool successfully: ${JSON.stringify(used)}`);
    console.log(`  switched on for a chat: koala called ${[...new Set(used.map((result) => result.name))].join(', ')}`);

    const asked = (await http.post('/conversations', {})).data.id as string;
    conversations.push(asked);
    const before = called(await turn(http, 'koala', `Switch on my ${server.name} for this chat — I want you to browse my repositories.`, asked), prefix);
    assert.equal(before.length, 0, 'its tools were available before anyone approved them');
    const request = await until('the switch-on request', async () => {
      const list = (await http.get('/mcp/requests', { params: { conversationId: asked } })).data as { id: string; server: string; status: string }[];
      return list.find((entry) => entry.server === server.name && entry.status === 'requested');
    });
    await http.post(`/mcp/requests/${request.id}/enable`);
    const after = called(await turn(http, 'koala', 'Thanks, it is on now. List my repositories — just the names.', asked), prefix);
    assert.ok(after.some((result) => result.ok), 'the tools did not arrive after the request was approved');
    console.log(`  koala asked, the card approved it, and the next turn used ${[...new Set(after.map((result) => result.name))].join(', ')}`);

    const saved = await http.put(`/agents/${persona}`, {
      slug: persona,
      name: 'MCP live check',
      description: 'Lists repositories through an MCP server',
      version: '1',
      prompt: 'You answer questions about the person\'s repositories using the tools you have.',
      guidance: 'Delegate here to look at repositories.',
      returns: 'An answer.',
      failures: [{ when: 'the server does not answer', says: 'so' }],
      procedure: 'tool-rounds',
      tools: [],
      mcp: [server.name],
      environment: {},
    });
    assert.ok(saved.status < 300, `the persona was not saved: ${JSON.stringify(saved.data)}`);
    const granted = called(await turn(http, persona, 'List the repositories — just the names.'), prefix);
    assert.ok(granted.some((result) => result.ok), 'a persona granted the server could not use it');
    console.log(`  granted to a persona: it called ${[...new Set(granted.map((result) => result.name))].join(', ')}`);
    console.log('mcp live — PASS');
  } finally {
    await http.delete(`/agents/${persona}`).catch(() => undefined);
    for (const id of conversations) await http.delete(`/conversations/${id}`).catch(() => undefined);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
