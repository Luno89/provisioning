import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'http';
import { personaChatRouter } from './chat-pack.js';
import { mountRouter, type Harness } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';
import type { Persona } from '@koala/harness-types';

/**
 * HTTP-level proof the persona-pack router turns a pack into live Unified-wire frames.
 *
 * The real model call is replaced by a tiny local upstream returning one SSE content frame, so
 * runChatTurn runs end-to-end without a model. Asserts the route emits our typed frames
 * ({type:'content', delta:...}), not the raw provider leak.
 */

const fakePersona = (): Persona => ({
  id: 'p1', ownerId: 'test', name: 'Koala',
  systemPrompt: 'You are Koala.', overrides: {},
  createdAt: '', updatedAt: '',
});

const modelServiceStub = {
  resolveBaseUrl: async () => ({
    provider: { kind: 'openai', model: 'x' },
    baseUrl: 'http://127.0.0.1:PORT',
    apiKey: undefined,
  }),
};

let upstream: http.Server | null = null;
let port = 0;

function startUpstream(content: string) {
  return new Promise<void>((resolve) => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    upstream.listen(0, '127.0.0.1', () => {
      port = (upstream!.address() as { port: number }).port;
      modelServiceStub.resolveBaseUrl = async () => ({
        provider: { kind: 'openai', model: 'x' },
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: undefined,
      });
      resolve();
    });
  });
}

const harness: Harness = await mountRouter({
  prefix: '/api/chat',
  router: (db: Database) => personaChatRouter({
    db,
    modelService: modelServiceStub as any,
    resolvePersona: async () => fakePersona(),
    serversFor: async () => [],
    ownedConversations: async (userId: string) =>
      db.getConversations().then((c: any) => c.filter((x: any) => x.ownerId === userId)),
    webSearch: async () => ({ results: [] } as any),
    fetchWebPage: async () => '',
    toolRefused: () => false,
  }),
});

beforeAll(async () => {
  await startUpstream('hello-pack');
});

afterAll(async () => {
  await harness.close();
  upstream?.close?.();
});

describe('POST /api/chat/:packId — unified wire', () => {
  it('emits a {type:content} frame', async () => {
    const res = await fetch(harness.url('/api/chat/koala'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', message: 'hi' }),
    });
    const text = await res.text();
    const frames = text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    expect(frames.length).toBeGreaterThan(0);
    const first = JSON.parse(frames[0]!);
    expect(first.type).toBe('content');
    expect(first.delta.content).toBe('hello-pack');
  });

  it('rejects an empty message before streaming', async () => {
    const res = await fetch(harness.url('/api/chat/koala'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '  ' }),
    });
    expect(res.status).toBe(400);
  });
});