import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'http';
import { personaChatRouter } from './chat-pack.js';
import { mountRouter, type Harness } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';
import type { Persona, PersonaPack } from '@koala/harness-types';
import { TEST_USER } from './test-harness.js';
import { seedTools } from '../lib/tool-seeds.js';
import { PACK_SEEDS } from '../lib/pack-seeds.js';

const persona = (id: string, name: string, systemPrompt: string): Persona => ({
  id, ownerId: TEST_USER.id, name, systemPrompt,
  createdAt: '', updatedAt: '',
});

const pack = (slug: string, personaId: string, over: Partial<PersonaPack> = {}): PersonaPack => ({
  id: `pack-${slug}`, ownerId: TEST_USER.id, slug, name: slug,
  personaId,
  tools: ['propose_tree', 'propose_spec', 'list_infrastructure', 'get_logs', 'get_events',
    'inspect_resources', 'cluster_capacity', 'list_trees', 'deploy_project', 'get_project_url',
    'list_mcp_servers', 'enable_mcp_server', 'web_search', 'fetch_web_page'],
  sampling: PACK_SEEDS[0]!.sampling,
  overrides: {}, createdAt: '', updatedAt: '', ...over,
});

const modelServiceStub = {
  resolveBaseUrl: async () => ({
    provider: { kind: 'openai', model: 'x' },
    baseUrl: 'http://127.0.0.1:PORT',
    apiKey: undefined,
  }),
} as any;

let upstream: http.Server | null = null;

let lastRequestBody: any = null;

let upstreamToolCall: { name: string; args: string } | null = null;
let roundsSeen = 0;

function startUpstream(content: string) {
  return new Promise<void>((resolve) => {
    upstream = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => { lastRequestBody = buf ? JSON.parse(buf) : null; });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (upstreamToolCall && roundsSeen === 0) {
        roundsSeen += 1;
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{
            index: 0, id: 'tc1',
            function: { name: upstreamToolCall.name, arguments: upstreamToolCall.args },
          }] } }],
        })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    upstream.listen(0, '127.0.0.1', () => {
      modelServiceStub.resolveBaseUrl = async () => {
        const { port } = upstream!.address() as { port: number };
        return { provider: { kind: 'openai', model: 'x' }, baseUrl: `http://127.0.0.1:${port}`, apiKey: undefined };
      };
      resolve();
    });
  });
}

const harness: Harness = await mountRouter({
  prefix: '/api/chat-pack',
  router: (db: Database) => personaChatRouter({
    db,
    modelService: modelServiceStub,
    personaFor: async (userId, personaId) =>
      (await db.getPersonas()).find((p) => p.ownerId === userId && p.id === personaId),
    serversFor: async () => [],
    ownedConversations: async (userId: string) =>
      db.getConversations().then((c: any) => c.filter((x: any) => x.ownerId === userId)),
    webSearch: async () => ({ results: [] } as any),
    fetchWebPage: async () => '',
    toolRefused: () => false,
  }),
});

beforeAll(async () => {
  await startUpstream('hello-red-green');
  const db = harness.db;
  await seedTools(db);
  await db.savePersona(persona('p1', 'Koala', 'You are Koala.'));
  await db.savePersona(persona('p2', 'Researcher', 'You are a rigorous Researcher. Cite sources.'));
  await db.savePersonaPack(pack('koala', 'p1'));
  await db.savePersonaPack(pack('researcher', 'p2'));
  await db.savePersonaPack(pack('orphan', 'gone'));
});
afterAll(async () => { await harness.close(); upstream?.close?.(); });

describe('POST /api/chat-pack/:packId — unified wire (RED gate)', () => {
  it('goes through the engine and returns a typed frame', async () => {
    const res = await fetch(harness.url('/api/chat-pack/koala'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', message: 'hi' }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    expect(frames.length).toBeGreaterThan(0);
    const first = JSON.parse(frames[0]!);
    expect(first.type).toBe('content');
    expect(first.delta).toBe('hello-red-green');
  });

  it('serves a DIFFERENT persona pack with its own system prompt', async () => {
    const res = await fetch(harness.url('/api/chat-pack/researcher'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c2', message: 'research something' }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const system = lastRequestBody?.messages?.find((m: any) => m.role === 'system');
    expect(system?.content ?? '').toContain('rigorous Researcher');
    expect(system?.content ?? '').not.toContain('Koala');
  });

  it('rejects an empty message before streaming', async () => {
    const res = await fetch(harness.url('/api/chat-pack/koala'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '  ' }),
    });
    expect(res.status).toBe(400);
  });

  it('persists the assistant message to the conversation in the database', async () => {
    const convId = 'persist-test-1';
    const res = await fetch(harness.url('/api/chat-pack/koala'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: convId, message: 'tell me a joke' }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const conv = (await harness.db.getConversations()).find((c: any) => c.id === convId);
    expect(conv).toBeDefined();
    expect(conv?.messages.length).toBe(2);
    expect(conv?.messages[0]?.role).toBe('user');
    expect(conv?.messages[0]?.content).toBe('tell me a joke');
    expect(conv?.messages[1]?.role).toBe('assistant');
    expect(conv?.messages[1]?.content).toBe('hello-red-green');
  });

  it('provides conversation CRUD endpoints', async () => {
    const createRes = await fetch(harness.url('/api/chat-pack/conversations'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'My Custom Thread' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string };
    expect(created.id).toBeDefined();

    const listRes = await fetch(harness.url('/api/chat-pack/conversations'));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as any[];
    expect(list.some((c: any) => c.id === created.id)).toBe(true);

    const getRes = await fetch(harness.url(`/api/chat-pack/conversations/${created.id}`));
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as { id: string };
    expect(got.id).toBe(created.id);

    const delRes = await fetch(harness.url(`/api/chat-pack/conversations/${created.id}`), { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const afterDel = (await harness.db.getConversations()).find((c: any) => c.id === created.id);
    expect(afterDel).toBeUndefined();
  });

  it('accepts project tree and app spec proposals', async () => {
    const convId = 'proposal-test-conv';
    const now = new Date().toISOString();
    await harness.db.saveConversation({
      id: convId,
      ownerId: 'test-user',
      title: 'Proposal Conv',
      messages: [],
      proposedTrees: [{ id: 'prop-tree-1', name: 'New Project', type: 'web', goal: 'Build web app', proposedAt: now }],
      proposedSpecs: [{
        id: 'my-custom-app',
        proposedAt: now,
        spec: {
          id: 'my-custom-app',
          image: 'nginx:alpine',
          ports: [{ name: 'http', port: 80 }],
          resources: { limits: { memory: '512Mi', cpu: '500m' } },
        },
      }],
      createdAt: now,
      updatedAt: now,
    });

    const treeRes = await fetch(harness.url(`/api/chat-pack/conversations/${convId}/trees/prop-tree-1/accept`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(treeRes.status).toBe(200);
    const treeBody = (await treeRes.json()) as { tree?: { id: string } };
    expect(treeBody.tree?.id).toBeDefined();

    const specRes = await fetch(harness.url(`/api/chat-pack/conversations/${convId}/specs/my-custom-app/accept`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(specRes.status).toBe(200);
    const specBody = (await specRes.json()) as { id: string };
    expect(specBody.id).toBe('my-custom-app');
  });

  it('supplies the granted tools as function schemas to the provider', async () => {
    const res = await fetch(harness.url('/api/chat-pack/koala'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'tools-check-conv', message: 'check tools' }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const tools = lastRequestBody?.tools as Array<{ type: string; function: { name: string; description: string } }>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(10);
    const toolNames = tools.map((t) => t.function?.name);
    expect(toolNames).toContain('propose_tree');
    expect(toolNames).toContain('propose_spec');
    expect(toolNames).toContain('list_infrastructure');
    expect(toolNames).toContain('get_logs');
    expect(toolNames).toContain('get_events');
    expect(toolNames).toContain('inspect_resources');
    expect(toolNames).toContain('cluster_capacity');
    expect(toolNames).toContain('list_trees');
    expect(toolNames).toContain('enable_mcp_server');
    expect(toolNames).toContain('web_search');
  });
});

describe('a pack that cannot run', () => {
  it('404s an unknown pack instead of throwing a 500', async () => {
    const res = await fetch(harness.url('/api/chat-pack/does-not-exist'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c-404', message: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  it('refuses a pack whose persona is gone, rather than silently running as Koala', async () => {
    const res = await fetch(harness.url('/api/chat-pack/orphan'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c-409', message: 'hi' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toMatch(/no longer exists/i);
    expect(body.error).toMatch(/orphan/);
  });

  it('does not serve another user\'s pack', async () => {
    await harness.db.savePersonaPack({
      id: 'pack-theirs', ownerId: 'someone-else', slug: 'theirs', name: 'Theirs',
      personaId: 'p1', tools: [],
      sampling: PACK_SEEDS[0]!.sampling,
      overrides: {}, createdAt: '', updatedAt: '',
    });
    const res = await fetch(harness.url('/api/chat-pack/theirs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c-x', message: 'hi' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('the pack decides the turn', () => {
  const turn = (slug: string, id: string) => fetch(harness.url(`/api/chat-pack/${slug}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: id, message: 'go' }),
  }).then((r) => r.text());

  it('offers only the tools the pack grants', async () => {
    await harness.db.savePersonaPack(pack('narrow', 'p1', { tools: ['get_logs'] }));
    await turn('narrow', 'c-tools');
    const names = (lastRequestBody?.tools ?? []).map((t: any) => t.function.name);
    expect(names).toEqual(['get_logs']);
  });

  it('offers nothing when the pack grants nothing', async () => {
    await harness.db.savePersonaPack(pack('empty', 'p1', { tools: [] }));
    await turn('empty', 'c-none');
    expect(lastRequestBody?.tools ?? []).toEqual([]);
  });

  it('ignores a granted name that is not a real tool', async () => {
    await harness.db.savePersonaPack(pack('typo', 'p1', { tools: ['get_logs', 'gte_logs'] }));
    await turn('typo', 'c-typo');
    const names = (lastRequestBody?.tools ?? []).map((t: any) => t.function.name);
    expect(names).toEqual(['get_logs']);
  });

  it('puts the granted tools in the prompt, and only those', async () => {
    await turn('narrow', 'c-prompt');
    const system = lastRequestBody?.messages?.find((m: any) => m.role === 'system')?.content ?? '';
    expect(system).toMatch(/get_logs/);
    expect(system).not.toMatch(/deploy_project/);
  });

  it('applies the pack\'s sampling overrides to the call', async () => {
    await harness.db.savePersonaPack(pack('cold', 'p1', { overrides: { temperature: 0.05 } }));
    await turn('cold', 'c-temp');
    expect(lastRequestBody?.temperature).toBe(0.05);
  });
});

