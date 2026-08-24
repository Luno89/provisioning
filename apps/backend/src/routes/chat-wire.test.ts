import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { chatRouter } from './chat.js';
import { koalaRouter } from './koala.js';
import { createDatabase } from '../lib/db-interface.js';
import type { Database } from '../lib/db-interface.js';
import { ownedBy } from '../lib/ownership.js';

/**
 * CHARACTERISATION TESTS — what the two chat routes put on the wire, byte for byte.
 *
 * ── WHY THESE EXIST ──
 * `/api/chat` and `/api/koala/chat` speak DIFFERENT SSE protocols, and that is deliberate:
 *
 *   /api/chat        forwards the upstream provider's own OpenAI frames verbatim
 *                    (`res.write(Buffer.from(value))`), because the frontend parses
 *                    `choices[0].delta` straight off them.
 *   /api/koala/chat  emits its own envelope — `{delta}` / `{reasoning}` / `{toolCall}` /
 *                    `{toolResult}`.
 *
 * Both were confirmed live against a real model before this file was written; these assertions are
 * a transcription of what actually came back, not a guess at what should.
 *
 * The two round loops are candidates for consolidation behind one emitter-driven `lib/chat-turn.ts`.
 * That change is only safe if something notices when a frame's SHAPE moves, and nothing did — no
 * test touched either route's output. A refactor that "works" while re-encoding
 * `reasoning_content` as `reasoning` breaks the chat pane and passes every other test in the repo.
 *
 * ── WHY A REAL UPSTREAM SERVER AND NOT A `fetch` MOCK ──
 * Both routes call global `fetch` against `${baseUrl}/chat/completions`. A mock returning a
 * hand-built `ReadableStream` would let a bug in how the route CHUNKS bytes go unnoticed, and
 * chunk boundaries are exactly what SSE gets wrong: a frame split across two writes without its
 * blank-line delimiter never fires `onmessage`, and presents as a hang rather than an error. So
 * the fake upstream is a real HTTP server writing real bytes, and it deliberately splits one frame
 * mid-JSON to prove the boundary survives the trip.
 */

/** An OpenAI-compatible upstream that replays a scripted body. */
async function fakeUpstream(script: string[], opts: { splitAt?: number } = {}) {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(body ? JSON.parse(body) : null);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const whole = script.join('');
      if (opts.splitAt) {
        // Mid-JSON split: proves the route reassembles across chunk boundaries rather than
        // assuming one read == one frame.
        res.write(whole.slice(0, opts.splitAt));
        setTimeout(() => { res.write(whole.slice(opts.splitAt)); res.end(); }, 5);
      } else {
        res.write(whole);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    /** The request bodies the route sent upstream, in order. */
    requests: seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** One OpenAI streaming frame, as the provider writes it. */
const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

/** Collects an SSE response into its `data:` payloads. */
async function collect(res: Response): Promise<string[]> {
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => b.slice(6));
}

const USER = { id: 'test-user', email: 'test@example.com' };

function serve(mount: (db: Database) => express.Router, prefix: string, db: Database) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = USER; next(); });
  app.use(prefix, mount(db));
  const server = http.createServer(app);
  return new Promise<{ url: (p: string) => string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: (p: string) => `http://127.0.0.1:${port}${p}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('/api/chat wire format', () => {
  let db: Database;
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let ctx: Awaited<ReturnType<typeof serve>>;

  const build = (baseUrl: string) => (database: Database) => chatRouter({
    db: database,
    modelService: {
      resolveBaseUrl: async () => ({ provider: { id: 'p1', name: 'test' } as any, baseUrl }),
      resolveExtractor: async () => undefined,
    } as any,
    temporalBridge: {} as any,
    projectRepoService: {} as any,
    ownedPersonas: async (uid) => ownedBy(await database.getPersonas(), uid),
    ownedBranches: async (uid) => ownedBy(await database.getBranches(), uid),
    ownedLeaves: async (uid) => ownedBy(await database.getLeaves(), uid),
    ownedTrees: async (uid) => ownedBy(await database.getTrees(), uid),
    runLeafTool: async () => ({ ok: true, result: '{}' }),
    toolRefused: () => false,
  });

  beforeEach(async () => {
    db = createDatabase();
    await db.init();
  });

  afterEach(async () => {
    await ctx?.close();
    await up?.close();
  });

  /**
   * The passthrough contract. Every byte the provider wrote must arrive unchanged — the frontend
   * reads `choices[0].delta.content`, so decoding and re-encoding here would silently drop any
   * field the re-encoder did not know about (`reasoning_content` being the one that matters today).
   */
  it('forwards the upstream frames verbatim and terminates with [DONE]', async () => {
    const script = [
      frame({ role: 'assistant', content: '' }),
      frame({ content: 'Hello' }),
      frame({ content: ' world' }),
      frame({}, 'stop'),
      'data: [DONE]\n\n',
    ];
    up = await fakeUpstream(script);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);

    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });

    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    // nginx buffers proxied responses by default; without this every frame arrives at once when
    // the response ends, which looks exactly like a model that produced nothing until it finished.
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const frames = await collect(res as unknown as Response);
    const content = frames
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f).choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(content).toBe('Hello world');
    expect(frames.at(-1)).toBe('[DONE]');

    // The shape itself, not just the text: these keys are what `lib/stream-delta.ts` reads.
    const first = JSON.parse(frames[0]!);
    expect(first).toHaveProperty('choices.0.delta');
    expect(first.object).toBe('chat.completion.chunk');
  });

  /**
   * `reasoning_content` is a separate field from `content` and the pane renders it in a think
   * block. A re-encoder that normalised it to `reasoning` — koala's name for the same thing —
   * would put the model's private reasoning into the visible answer.
   */
  it('preserves reasoning_content under its own key, distinct from content', async () => {
    up = await fakeUpstream([
      frame({ reasoning_content: 'thinking...' }),
      frame({ content: 'answer' }),
      'data: [DONE]\n\n',
    ]);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);

    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const deltas = (await collect(res as unknown as Response))
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f).choices[0].delta);

    expect(deltas[0]).toEqual({ reasoning_content: 'thinking...' });
    expect(deltas[1]).toEqual({ content: 'answer' });
    expect(deltas[0]).not.toHaveProperty('content');
  });

  /** A frame split across two TCP writes must still arrive as one frame. */
  it('survives a frame split mid-JSON by the upstream', async () => {
    const script = [frame({ content: 'abcdef' }), 'data: [DONE]\n\n'];
    up = await fakeUpstream(script, { splitAt: 40 });
    ctx = await serve(build(up.baseUrl), '/api/chat', db);

    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const frames = await collect(res as unknown as Response);
    const content = frames.filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f).choices[0].delta.content ?? '').join('');
    expect(content).toBe('abcdef');
  });

  it('rejects a request with no messages before opening a stream', async () => {
    up = await fakeUpstream([]);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);
    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});

describe('/api/koala/chat wire format', () => {
  let db: Database;
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let ctx: Awaited<ReturnType<typeof serve>>;

  const build = (baseUrl: string) => (database: Database) => koalaRouter({
    db: database,
    modelService: {
      resolveBaseUrl: async () => ({ provider: { id: 'p1', name: 'test' } as any, baseUrl }),
    } as any,
    // Returns a persona rather than seeding one: what Koala IS is `lib/koala-persona.ts`'s
    // business, and this file is about frames.
    ensureKoala: async () => ({
      id: 'koala', ownerId: USER.id, name: 'Koala', model: 'test',
      systemPrompt: 'be helpful', createdAt: new Date().toISOString(),
    } as any),
    ensurePersonas: async () => {},
    koalaServers: async () => [],
    ownedConversations: async (uid) => ownedBy(await database.getConversations(), uid),
    executeWebSearch: async () => ({ ok: true, results: [] } as any),
    executeFetchWebPage: async () => '',
    toolRefused: () => false,
  });

  async function conversation() {
    const record = {
      id: 'conv-1', ownerId: USER.id, title: 'test', messages: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await db.saveConversation(record as any);
    return record;
  }

  beforeEach(async () => {
    db = createDatabase();
    await db.init();
  });

  afterEach(async () => {
    await ctx?.close();
    await up?.close();
  });

  /**
   * Koala's OWN envelope, which is not the upstream's. The chat pane parses `{delta}`, so a
   * consolidation that started forwarding raw provider frames here would render nothing at all.
   */
  it('re-encodes upstream content as {delta} rather than forwarding provider frames', async () => {
    up = await fakeUpstream([
      frame({ role: 'assistant', content: '' }),
      frame({ content: 'Hello' }),
      frame({ content: ' world' }),
      frame({}, 'stop'),
      'data: [DONE]\n\n',
    ]);
    ctx = await serve(build(up.baseUrl), '/api/koala', db);
    await conversation();

    const res = await fetch(ctx.url('/api/koala/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-1', message: 'hi' }),
    });

    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const frames = await collect(res as unknown as Response);
    const payloads = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f));

    expect(payloads.every((p) => !('choices' in p))).toBe(true);
    expect(payloads.map((p) => p.delta ?? '').join('')).toBe('Hello world');
    expect(frames.at(-1)).toBe('[DONE]');
  });

  /**
   * `reasoning`, not `reasoning_content`. The two routes name the same concept differently, which
   * is precisely the kind of difference a shared emitter would flatten by accident.
   */
  it('emits reasoning under {reasoning}, its own key and not the provider\'s', async () => {
    up = await fakeUpstream([
      frame({ reasoning_content: 'thinking...' }),
      frame({ content: 'answer' }),
      'data: [DONE]\n\n',
    ]);
    ctx = await serve(build(up.baseUrl), '/api/koala', db);
    await conversation();

    const res = await fetch(ctx.url('/api/koala/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-1', message: 'hi' }),
    });
    const payloads = (await collect(res as unknown as Response))
      .filter((f) => f !== '[DONE]').map((f) => JSON.parse(f));

    expect(payloads.filter((p) => 'reasoning' in p).map((p) => p.reasoning).join('')).toBe('thinking...');
    expect(payloads.filter((p) => 'delta' in p).map((p) => p.delta).join('')).toBe('answer');
    // The distinction that matters: reasoning never leaks into the visible answer.
    expect(payloads.some((p) => p.delta?.includes('thinking'))).toBe(false);
  });

  it('persists the turn on the conversation it was given', async () => {
    up = await fakeUpstream([frame({ content: 'answer' }), 'data: [DONE]\n\n']);
    ctx = await serve(build(up.baseUrl), '/api/koala', db);
    await conversation();

    // The body must be drained, not just awaited: `fetch` resolves when the HEADERS arrive, and
    // an SSE route sends those first. The turn is persisted after the stream closes, so asserting
    // on the database before reading the body races the handler — and lost, silently, at first.
    const res = await fetch(ctx.url('/api/koala/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-1', message: 'hi' }),
    });
    await res.text();

    const saved = (await db.getConversations()).find((c) => c.id === 'conv-1');
    const roles = (saved?.messages ?? []).map((m: any) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  /**
   * 404 for a conversation belonging to someone else, and the SAME 404 for one that does not
   * exist — a guessed id must not confirm which conversations are real.
   */
  it('does not distinguish another tenant\'s conversation from a missing one', async () => {
    up = await fakeUpstream([]);
    ctx = await serve(build(up.baseUrl), '/api/koala', db);
    await db.saveConversation({
      id: 'someone-elses', ownerId: 'other-user', title: 'x', messages: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as any);

    const theirs = await fetch(ctx.url('/api/koala/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'someone-elses', message: 'hi' }),
    });
    const missing = await fetch(ctx.url('/api/koala/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'no-such-id', message: 'hi' }),
    });

    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await theirs.json()).toEqual(await missing.json());
  });

  it('rejects an empty message before opening a stream', async () => {
    up = await fakeUpstream([]);
    ctx = await serve(build(up.baseUrl), '/api/koala', db);
    await conversation();
    const res = await fetch(ctx.url('/api/koala/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-1', message: '   ' }),
    });
    expect(res.status).toBe(400);
  });
});
