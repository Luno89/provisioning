import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { chatRouter } from './chat.js';
import { createDatabase } from '../lib/db-interface.js';
import type { Database } from '../lib/db-interface.js';
import { ownedBy } from '../lib/ownership.js';
import { seedPacks } from '../lib/pack-seeds.js';
import { seedPersonas } from '../lib/persona-seeds.js';
import { seedTools } from '../lib/tool-seeds.js';
import { getModelRateLimiterSnapshot } from '../lib/model-rate-limiter.js';
import { PersonaPackService } from '../services/PersonaPackService.js';
import { PACK_SEEDS } from '../lib/pack-seeds.js';
import type { Persona, PersonaPack } from '@koala/harness-types';

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
  app.use(express.json({ limit: '20mb' }));
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

function chatDeps(database: Database, overrides: Record<string, unknown> = {}) {
  return {
    db: database,
    modelService: {
      resolveBaseUrl: async () => ({ provider: { id: 'p1', name: 'test' } as any, baseUrl: '' }),
      resolveExtractor: async () => undefined,
    } as any,
    temporalBridge: {} as any,
    projectRepoService: {} as any,
    ownedBranches: async (uid: string) => ownedBy(await database.getBranches(), uid),
    ownedLeaves: async (uid: string) => ownedBy(await database.getLeaves(), uid),
    ownedTrees: async (uid: string) => ownedBy(await database.getTrees(), uid),
    webSearch: async () => ({ results: [] } as any),
    fetchWebPage: async () => '',
    toolRefused: () => false,
    packs: new PersonaPackService(database),
    serversFor: async () => [],
    ownedConversations: async (uid: string) => (await database.getConversations()).filter((c: any) => c.ownerId === uid),
    ...overrides,
  };
}

describe('/api/chat wire format — UnifiedFrame, one engine for every scope', () => {
  let db: Database;
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let ctx: Awaited<ReturnType<typeof serve>>;

  const build = (baseUrl: string) => (database: Database) => chatRouter(chatDeps(database, {
    modelService: {
      resolveBaseUrl: async () => ({ provider: { id: 'p1', name: 'test' } as any, baseUrl }),
      resolveExtractor: async () => undefined,
    } as any,
  }) as any);

  beforeEach(async () => {
    db = createDatabase();
    await db.init();
    // The turn's budget is the pack's, so the shipped packs have to be present.
    await seedPersonas(db as never);
    await seedPacks(db as never);
    await db.saveBranch({
      id: 'branch-generic', ownerId: USER.id, title: 'Demo', messages: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    } as never);
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
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], branchId: 'branch-generic' }),
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
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], branchId: 'branch-generic' }),
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
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], branchId: 'branch-generic' }),
    });
    const frames = (await collect(res as unknown as Response))
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f));
    const content = frames.filter((f) => f.type === 'content').map((f) => f.delta).join('');
    expect(content).toBe('abcdef');
  });

  it('accepts a large transcript that would have exceeded Express\'s default 100kb JSON limit', async () => {
    const bigContent = 'x'.repeat(60_000);
    up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);

    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        branchId: 'branch-generic',
        messages: [
          { role: 'user', content: bigContent },
          { role: 'assistant', content: bigContent },
          { role: 'user', content: 'go' },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a branch-scoped request with no messages before opening a stream', async () => {
    up = await fakeUpstream([]);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);
    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branchId: 'branch-generic' }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('rejects a conversation-scoped request with no message before opening a stream', async () => {
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

  it('warns once over SSE on an overthinking loop, and records a failure sample once the client aborts in response', async () => {
    const degenerate = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < 35; i++) {
        res.write(frame({ reasoning_content: 'Wait I should check if user needs leaves. ' }));
      }
      req.on('close', () => { try { res.end(); } catch { /* ignored */ } });
    });
    await new Promise<void>((r) => degenerate.listen(0, r));
    const port = (degenerate.address() as { port: number }).port;

    ctx = await serve((database: Database) => chatRouter(chatDeps(database, {
      modelService: {
        resolveBaseUrl: async () => ({
          provider: { id: 'p1', name: 'test', model: 'degenerate-model' } as any,
          baseUrl: `http://127.0.0.1:${port}`,
        }),
        resolveExtractor: async () => undefined,
      } as any,
    }) as any), '/api/chat', db);

    try {
      const controller = new AbortController();
      const res = await fetch(ctx.url('/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], branchId: 'branch-generic' }),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);

      const reader = (res.body as any).getReader();
      const decoder = new TextDecoder();
      let sawWarning = false;
      const deadline = Date.now() + 5000;
      while (!sawWarning && Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        if (decoder.decode(value).includes('"overthinkWarning"')) sawWarning = true;
      }
      expect(sawWarning).toBe(true);

      controller.abort();
      await reader.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const profile = await db.getModelThinkingProfile?.('degenerate-model');
      expect(profile?.failureSamples).toBeGreaterThan(0);
    } finally {
      await degenerate.close();
    }
  }, 10_000);

  it('tells the model it is running on a local machine when the branch\'s project is device-backed', async () => {
    await db.saveLocalAgentDevice({
      id: 'dev-1', ownerId: USER.id, name: 'My Laptop', rootDir: '/x',
      tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z',
    });
    await db.saveProjectInfo({
      id: 'proj-1', name: 'demo', ownerId: USER.id, appType: 'local', createdAt: '2026-01-01T00:00:00Z',
      executionTarget: { kind: 'local-device', deviceId: 'dev-1', path: 'apps/thing' },
    } as never);
    await db.saveTree({
      id: 'tree-1', ownerId: USER.id, name: 'Demo', type: 'no-such-type', projectIds: ['proj-1'],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    } as never);
    await db.saveBranch({
      id: 'branch-1', ownerId: USER.id, treeId: 'tree-1', title: 'Demo', messages: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    } as never);

    up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);

    const res1 = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], branchId: 'branch-1', mode: 'chat' }),
    });
    await res1.text();

    const system = up.requests[0]?.messages?.find((m: any) => m.role === 'system');
    expect(system?.content).toMatch(/local machine "My Laptop, in apps\/thing"/);
    expect(system?.content).toMatch(/git remote -v/);
  });

  it('says nothing about a local machine for a branch with no project, or a cluster-backed one', async () => {
    await db.saveTree({
      id: 'tree-2', ownerId: USER.id, name: 'Demo2', type: 'no-such-type',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    } as never);
    await db.saveBranch({
      id: 'branch-2', ownerId: USER.id, treeId: 'tree-2', title: 'Demo2', messages: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    } as never);

    up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);

    const res2 = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], branchId: 'branch-2', mode: 'chat' }),
    });
    await res2.text();

    const system = up.requests[0]?.messages?.find((m: any) => m.role === 'system');
    expect(JSON.stringify(system ?? '')).not.toMatch(/local machine/);
  });
});

describe('model rate limiter wiring — /api/chat, branch scope', () => {
  let db: Database;
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let ctx: Awaited<ReturnType<typeof serve>>;

  beforeEach(async () => {
    db = createDatabase();
    await db.init();
    await seedPersonas(db as never);
    await seedPacks(db as never);
    await db.saveBranch({
      id: 'branch-generic', ownerId: USER.id, title: 'Demo', messages: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    } as never);
  });

  afterEach(async () => {
    await ctx?.close();
    await up?.close();
  });

  const buildWithProvider = (baseUrl: string, provider: Record<string, unknown>) => (database: Database) => chatRouter(chatDeps(database, {
    modelService: {
      resolveBaseUrl: async () => ({ provider: provider as any, baseUrl }),
      resolveExtractor: async () => undefined,
    } as any,
  }) as any);

  it('routes a credentialed endpoint\'s calls through the shared rate limiter', async () => {
    const endpointId = `ep-chat-${Math.random()}`;
    up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
    ctx = await serve(
      buildWithProvider(up.baseUrl, { id: endpointId, name: 'Test Endpoint', kind: 'openai', model: 'x', source: 'endpoint' }),
      '/api/chat', db,
    );

    await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], branchId: 'branch-generic' }),
    }).then((r) => r.text());

    const snapshot = getModelRateLimiterSnapshot(USER.id);
    const bucket = snapshot.find((b) => b.key === endpointId);
    expect(bucket).toBeDefined();
    expect(bucket!.totalRequests).toBeGreaterThan(0);
  });

  it('does not create a new rate-limit bucket for a provider with no endpoint id', async () => {
    const before = getModelRateLimiterSnapshot(USER.id).length;
    up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
    ctx = await serve(buildWithProvider(up.baseUrl, { id: 'p1', name: 'test' }), '/api/chat', db);

    await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], branchId: 'branch-generic' }),
    }).then((r) => r.text());

    expect(getModelRateLimiterSnapshot(USER.id).length).toBe(before);
  });
});

describe('salvage-on-abort — /api/chat, branch scope', () => {
  let db: Database;
  let ctx: Awaited<ReturnType<typeof serve>>;

  beforeEach(async () => {
    db = createDatabase();
    await db.init();
    await seedPersonas(db as never);
    await seedPacks(db as never);
  });

  afterEach(async () => {
    await ctx?.close();
  });

  it('salvages the partial reply onto the branch transcript when the client aborts mid-stream', async () => {
    await db.saveBranch({
      id: 'branch-salvage', ownerId: USER.id, title: 'Demo', messages: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    } as never);

    const slowUpstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial answer before stop' } }] })}\n\n`);
      req.on('close', () => { try { res.end(); } catch { /* ignored */ } });
    });
    await new Promise<void>((resolve) => slowUpstream.listen(0, '127.0.0.1', () => resolve()));
    const { port } = slowUpstream.address() as { port: number };

    ctx = await serve((database: Database) => chatRouter(chatDeps(database, {
      modelService: {
        resolveBaseUrl: async () => ({
          provider: { id: 'p1', name: 'test', kind: 'openai', model: 'slow-model' } as any,
          baseUrl: `http://127.0.0.1:${port}`,
        }),
        resolveExtractor: async () => undefined,
      } as any,
    }) as any), '/api/chat', db);

    try {
      const controller = new AbortController();
      const res = await fetch(ctx.url('/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'go slow' }], branchId: 'branch-salvage', mode: 'chat' }),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let sawContent = false;
      const deadline = Date.now() + 5000;
      while (!sawContent && Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        if (decoder.decode(value).includes('Partial answer before stop')) sawContent = true;
      }
      expect(sawContent).toBe(true);

      controller.abort();
      await reader.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const branch = (await db.getBranches()).find((b) => b.id === 'branch-salvage');
      expect(branch?.messages.length).toBe(2);
      expect(branch?.messages[1]?.role).toBe('assistant');
      expect(branch?.messages[1]?.content).toBe('Partial answer before stop');
      expect(branch?.messages[1]?.interruptedReason).toBe('Stopped');
    } finally {
      slowUpstream.close();
    }
  }, 10_000);
});

const koalaPersona = (id: string, name: string, systemPrompt: string): Persona => ({
  id, ownerId: USER.id, name, systemPrompt,
  createdAt: '', updatedAt: '',
});

const koalaPack = (slug: string, personaId: string, over: Partial<PersonaPack> = {}): PersonaPack => ({
  id: `pack-${slug}`, ownerId: USER.id, slug, name: slug,
  personaId,
  tools: ['propose_tree', 'propose_spec', 'list_infrastructure', 'get_logs', 'get_events',
    'inspect_resources', 'cluster_capacity', 'list_trees', 'deploy_project', 'get_project_url',
    'list_mcp_servers', 'enable_mcp_server', 'web_search', 'fetch_web_page'],
  sampling: PACK_SEEDS[0]!.sampling, budget: PACK_SEEDS[0]!.budget, prompt: PACK_SEEDS[0]!.prompt, createdAt: '', updatedAt: '', ...over,
});

describe('/api/chat — conversation scope (no branchId), always koala', () => {
  let db: Database;
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let ctx: Awaited<ReturnType<typeof serve>>;

  const build = (baseUrl: string) => (database: Database) => chatRouter(chatDeps(database, {
    modelService: {
      resolveBaseUrl: async () => ({ provider: { kind: 'openai', model: 'x' } as any, baseUrl }),
      resolveExtractor: async () => undefined,
    } as any,
  }) as any);

  beforeEach(async () => {
    db = createDatabase();
    await db.init();
    await seedTools(db);
    await db.savePersona(koalaPersona('p1', 'Koala', 'You are Koala.'));
    await db.savePersonaPack(koalaPack('koala', 'p1'));
  });

  afterEach(async () => {
    await ctx?.close();
    await up?.close();
  });

  it('goes through the engine and returns a typed frame', async () => {
    up = await fakeUpstream([frame({ content: 'hello-red-green' }, 'stop'), 'data: [DONE]\n\n']);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);

    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', message: 'hi' }),
    });
    expect(res.status).toBe(200);
    const frames = await collect(res as unknown as Response);
    const first = JSON.parse(frames[0]!);
    expect(first.type).toBe('content');
    expect(first.delta).toBe('hello-red-green');
  });

  it('persists the assistant message to the conversation in the database', async () => {
    const convId = 'persist-test-1';
    up = await fakeUpstream([frame({ content: 'hello-red-green' }, 'stop'), 'data: [DONE]\n\n']);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);

    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: convId, message: 'tell me a joke' }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const conv = (await db.getConversations()).find((c: any) => c.id === convId);
    expect(conv).toBeDefined();
    expect(conv?.messages.length).toBe(2);
    expect(conv?.messages[0]?.role).toBe('user');
    expect(conv?.messages[0]?.content).toBe('tell me a joke');
    expect(conv?.messages[1]?.role).toBe('assistant');
    expect(conv?.messages[1]?.content).toBe('hello-red-green');
  });

  it('salvages the partial reply into the conversation when the client aborts mid-stream', async () => {
    const convId = 'abort-salvage-1';
    const slowUpstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial answer before stop' } }] })}\n\n`);
      req.on('close', () => { try { res.end(); } catch { /* ignored */ } });
    });
    await new Promise<void>((resolve) => slowUpstream.listen(0, '127.0.0.1', () => resolve()));
    const { port } = slowUpstream.address() as { port: number };
    ctx = await serve(build(`http://127.0.0.1:${port}`), '/api/chat', db);

    try {
      const controller = new AbortController();
      const res = await fetch(ctx.url('/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, message: 'go slow' }),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let sawContent = false;
      const deadline = Date.now() + 5000;
      while (!sawContent && Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        if (decoder.decode(value).includes('Partial answer before stop')) sawContent = true;
      }
      expect(sawContent).toBe(true);

      controller.abort();
      await reader.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const conv = (await db.getConversations()).find((c: any) => c.id === convId);
      expect(conv?.messages.length).toBe(2);
      expect(conv?.messages[1]?.role).toBe('assistant');
      expect(conv?.messages[1]?.content).toBe('Partial answer before stop');
      expect(conv?.messages[1]?.interruptedReason).toBe('Stopped');
    } finally {
      slowUpstream.close();
    }
  }, 10_000);

  it('supplies the granted tools as function schemas to the provider', async () => {
    up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
    ctx = await serve(build(up.baseUrl), '/api/chat', db);

    const res = await fetch(ctx.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'tools-check-conv', message: 'check tools' }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const tools = up.requests[0]?.tools as Array<{ type: string; function: { name: string; description: string } }>;
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

  describe('when koala cannot run', () => {
    it('refuses when koala\'s own persona is gone, rather than silently substituting one', async () => {
      await db.savePersonaPack(koalaPack('koala', 'gone'));
      up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
      ctx = await serve(build(up.baseUrl), '/api/chat', db);

      const res = await fetch(ctx.url('/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'c-409', message: 'hi' }),
      });
      expect(res.status).toBe(409);
      const body = await res.json() as any;
      expect(body.error).toMatch(/no longer exists/i);
    });
  });

  describe('koala\'s own configured pack decides the turn', () => {
    it('offers only the tools the pack grants', async () => {
      await db.savePersonaPack(koalaPack('koala', 'p1', { tools: ['get_logs'] }));
      up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
      ctx = await serve(build(up.baseUrl), '/api/chat', db);
      await fetch(ctx.url('/api/chat'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'c-tools', message: 'go' }),
      }).then((r) => r.text());
      const names = (up.requests[0]?.tools ?? []).map((t: any) => t.function.name);
      expect(names).toEqual(['get_logs']);
    });

    it('offers nothing when the pack grants nothing', async () => {
      await db.savePersonaPack(koalaPack('koala', 'p1', { tools: [] }));
      up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
      ctx = await serve(build(up.baseUrl), '/api/chat', db);
      await fetch(ctx.url('/api/chat'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'c-none', message: 'go' }),
      }).then((r) => r.text());
      expect(up.requests[0]?.tools ?? []).toEqual([]);
    });

    it('ignores a granted name that is not a real tool', async () => {
      await db.savePersonaPack(koalaPack('koala', 'p1', { tools: ['get_logs', 'gte_logs'] }));
      up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
      ctx = await serve(build(up.baseUrl), '/api/chat', db);
      await fetch(ctx.url('/api/chat'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'c-typo', message: 'go' }),
      }).then((r) => r.text());
      const names = (up.requests[0]?.tools ?? []).map((t: any) => t.function.name);
      expect(names).toEqual(['get_logs']);
    });

    it('puts the granted tools in the prompt, and only those', async () => {
      await db.savePersonaPack(koalaPack('koala', 'p1', { tools: ['get_logs'] }));
      up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
      ctx = await serve(build(up.baseUrl), '/api/chat', db);
      await fetch(ctx.url('/api/chat'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'c-prompt', message: 'go' }),
      }).then((r) => r.text());
      const system = up.requests[0]?.messages?.find((m: any) => m.role === 'system')?.content ?? '';
      expect(system).toMatch(/get_logs/);
      expect(system).not.toMatch(/deploy_project/);
    });

    it('applies the pack\'s own sampler to the call', async () => {
      await db.savePersonaPack(koalaPack('koala', 'p1', {
        sampling: { ...PACK_SEEDS[0]!.sampling, toolTurn: { temperature: 0.05 } },
      }));
      up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
      ctx = await serve(build(up.baseUrl), '/api/chat', db);
      await fetch(ctx.url('/api/chat'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'c-temp', message: 'go' }),
      }).then((r) => r.text());
      expect(up.requests[0]?.temperature).toBe(0.05);
    });
  });

  describe('overthink warning → confirmed kill', () => {
    it('warns once over SSE, and records a failure sample once the client aborts in response', async () => {
      const degenerate = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (let i = 0; i < 35; i++) {
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: 'Wait I should check if user needs leaves. ' } }],
          })}\n\n`);
        }
        req.on('close', () => { try { res.end(); } catch { /* ignored */ } });
      });
      await new Promise<void>((resolve) => degenerate.listen(0, '127.0.0.1', () => resolve()));
      const { port } = degenerate.address() as { port: number };
      ctx = await serve((database: Database) => chatRouter(chatDeps(database, {
        modelService: {
          resolveBaseUrl: async () => ({
            provider: { kind: 'openai', model: 'degenerate-model' } as any,
            baseUrl: `http://127.0.0.1:${port}`,
          }),
          resolveExtractor: async () => undefined,
        } as any,
      }) as any), '/api/chat', db);

      try {
        const controller = new AbortController();
        const res = await fetch(ctx.url('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversationId: 'c-overthink', message: 'go' }),
          signal: controller.signal,
        });
        expect(res.status).toBe(200);

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let sawWarning = false;
        const deadline = Date.now() + 5000;
        while (!sawWarning && Date.now() < deadline) {
          const { done, value } = await reader.read();
          if (done) break;
          if (decoder.decode(value).includes('"overthinkWarning"')) sawWarning = true;
        }
        expect(sawWarning).toBe(true);

        controller.abort();
        await reader.cancel().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 300));

        const profile = await db.getModelThinkingProfile?.('degenerate-model');
        expect(profile?.failureSamples).toBeGreaterThan(0);
      } finally {
        degenerate.close();
      }
    }, 10_000);
  });

  describe('model rate limiter wiring', () => {
    it('routes a credentialed endpoint\'s calls through the shared rate limiter', async () => {
      const endpointId = `ep-chat-${Math.random()}`;
      up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
      ctx = await serve((database: Database) => chatRouter(chatDeps(database, {
        modelService: {
          resolveBaseUrl: async () => ({
            provider: { id: endpointId, name: 'Test Endpoint', kind: 'openai', model: 'x', source: 'endpoint' } as any,
            baseUrl: up.baseUrl,
          }),
          resolveExtractor: async () => undefined,
        } as any,
      }) as any), '/api/chat', db);

      await fetch(ctx.url('/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'c-ratelimit', message: 'go' }),
      }).then((r) => r.text());

      const snapshot = getModelRateLimiterSnapshot(USER.id);
      const bucket = snapshot.find((b) => b.key === endpointId);
      expect(bucket).toBeDefined();
      expect(bucket!.totalRequests).toBeGreaterThan(0);
    });

    it('does not create a new rate-limit bucket for a provider with no endpoint id', async () => {
      const before = getModelRateLimiterSnapshot(USER.id).length;
      up = await fakeUpstream([frame({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
      ctx = await serve(build(up.baseUrl), '/api/chat', db);

      await fetch(ctx.url('/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'c-no-ratelimit', message: 'go' }),
      }).then((r) => r.text());

      expect(getModelRateLimiterSnapshot(USER.id).length).toBe(before);
    });
  });
});
