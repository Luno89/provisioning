import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'http';
import { personaChatRouter } from './chat-pack.js';
import { mountRouter, type Harness } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';
import type { Persona } from '@koala/harness-types';
import { getPersonaPack } from '../lib/persona-pack.js';

/**
 * RED for the persona-pack router: served over HTTP, a Koala-pack turn must come back as typed
 * UNIFIED frames ({type:'content', delta:...}) — not the raw provider envelope. Drove the router
 * into existence; watch it fail here first.
 */

const fakeKoala = (): Persona => ({
  id: 'p1', ownerId: 'test', name: 'Koala',
  systemPrompt: 'You are Koala.', overrides: {},
  createdAt: '', updatedAt: '',
});
const fakeResearcher = (): Persona => ({
  id: 'p2', ownerId: 'test', name: 'Researcher',
  systemPrompt: 'You are a rigorous Researcher. Cite sources.', overrides: {},
  createdAt: '', updatedAt: '',
});

const modelServiceStub = {
  resolveBaseUrl: async () => ({
    provider: { kind: 'openai', model: 'x' },
    baseUrl: 'http://127.0.0.1:PORT',
    apiKey: undefined,
  }),
} as any;

let upstream: http.Server | null = null;

/** The last request body the upstream saw — lets us assert which persona's prompt was sent. */
let lastRequestBody: any = null;

/** A tiny upstream answering ONE SSE content frame, capturing the request it received. */
function startUpstream(content: string) {
  return new Promise<void>((resolve) => {
    upstream = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => { lastRequestBody = buf ? JSON.parse(buf) : null; });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
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
    resolvePersona: async (_u, name) => (name === 'Researcher' ? fakeResearcher() : fakeKoala()),
    // register a second pack alongside the built-in koala
    pack: (id) => id === 'researcher'
      ? { id: 'researcher', persona: 'Researcher',
          env: { toolset: 'assistant', context: 'vault', mcp: 'session' },
          delivery: { content: true, thinking: false, tools: 'semantic', toolResults: true,
                      proposals: false, enable: false, plan: false, usage: false, telemetry: true },
          workflow: 'none' }
      : getPersonaPack(id),
    serversFor: async () => [],
    ownedConversations: async (userId: string) =>
      db.getConversations().then((c: any) => c.filter((x: any) => x.ownerId === userId)),
    webSearch: async () => ({ results: [] } as any),
    fetchWebPage: async () => '',
    toolRefused: () => false,
  }),
});

beforeAll(async () => { await startUpstream('hello-red-green'); });
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
    // The model was told it is a Researcher, not Koala — proving persona-driven, not hard-coded.
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
    // Create
    const createRes = await fetch(harness.url('/api/chat-pack/conversations'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'My Custom Thread' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string };
    expect(created.id).toBeDefined();

    // List
    const listRes = await fetch(harness.url('/api/chat-pack/conversations'));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as any[];
    expect(list.some((c: any) => c.id === created.id)).toBe(true);

    // Get
    const getRes = await fetch(harness.url(`/api/chat-pack/conversations/${created.id}`));
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as { id: string };
    expect(got.id).toBe(created.id);

    // Delete
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

    // Accept Tree Proposal
    const treeRes = await fetch(harness.url(`/api/chat-pack/conversations/${convId}/trees/prop-tree-1/accept`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(treeRes.status).toBe(200);
    const treeBody = (await treeRes.json()) as { tree?: { id: string } };
    expect(treeBody.tree?.id).toBeDefined();

    // Accept Spec Proposal
    const specRes = await fetch(harness.url(`/api/chat-pack/conversations/${convId}/specs/my-custom-app/accept`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(specRes.status).toBe(200);
    const specBody = (await specRes.json()) as { id: string };
    expect(specBody.id).toBe('my-custom-app');
  });

  it('supplies full KOALA_TOOLS function schemas to upstream provider for assistant packs', async () => {
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