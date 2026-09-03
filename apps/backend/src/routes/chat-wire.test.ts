import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { chatRouter } from './chat.js';
import { createDatabase } from '../lib/db-interface.js';
import type { Database } from '../lib/db-interface.js';
import { ownedBy } from '../lib/ownership.js';
import { seedPacks } from '../lib/pack-seeds.js';
import { seedPersonas } from '../lib/persona-seeds.js';

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
    requests: seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

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

describe('/api/chat wire format — UnifiedFrame, same engine as /api/chat-pack', () => {
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
    ownedBranches: async (uid) => ownedBy(await database.getBranches(), uid),
    ownedLeaves: async (uid) => ownedBy(await database.getLeaves(), uid),
    ownedTrees: async (uid) => ownedBy(await database.getTrees(), uid),
    webSearch: async () => ({ results: [] } as any),
    fetchWebPage: async () => '',
    toolRefused: () => false,
  });

  beforeEach(async () => {
    db = createDatabase();
    await db.init();
    // The turn's budget is the pack's, so the shipped packs have to be present.
    await seedPersonas(db as never);
    await seedPacks(db as never);
  });

  afterEach(async () => {
    await ctx?.close();
    await up?.close();
  });

  it('emits content frames and terminates with [DONE]', async () => {
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
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const frames = await collect(res as unknown as Response);
    expect(frames.at(-1)).toBe('[DONE]');

    const content = frames
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f))
      .filter((f) => f.type === 'content')
      .map((f) => f.delta)
      .join('');
    expect(content).toBe('Hello world');
  });

  it('emits reasoning under a distinct "thinking" frame type from "content"', async () => {
    up = await fakeUpstream([
      frame({ reasoning_content: 'thinking...' }),
      frame({ content: 'answer' }),
      'data: [DONE]\n\n',
    ]);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);

    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const frames = (await collect(res as unknown as Response))
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f));

    expect(frames.some((f) => f.type === 'thinking' && f.delta === 'thinking...')).toBe(true);
    expect(frames.some((f) => f.type === 'content' && f.delta === 'answer')).toBe(true);
  });

  it('survives a frame split mid-JSON by the upstream', async () => {
    const script = [frame({ content: 'abcdef' }), 'data: [DONE]\n\n'];
    up = await fakeUpstream(script, { splitAt: 40 });
    ctx = await serve(build(up.baseUrl), '/api/chat', db);

    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const frames = (await collect(res as unknown as Response))
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f));
    const content = frames.filter((f) => f.type === 'content').map((f) => f.delta).join('');
    expect(content).toBe('abcdef');
  });

  it('rejects a request with no messages before opening a stream', async () => {
    up = await fakeUpstream([]);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);
    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});
