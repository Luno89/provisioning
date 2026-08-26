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
});