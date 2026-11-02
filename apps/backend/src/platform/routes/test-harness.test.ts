import { IncomingMessage, ServerResponse, type RequestListener } from 'node:http';
import { Socket } from 'node:net';
import { Router } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { principalFrom } from '../middleware/auth.js';
import { memoryDatabase } from '../testing/memory-database.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';

const served = vi.hoisted(() => ({ app: undefined as RequestListener | undefined, port: 4321, closed: 0 }));

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
  ...actual,
  default: {
    ...actual,
    createServer: (app: RequestListener) => {
      served.app = app;
      return {
        listen: (_port: number, _host: string, ready: () => void) => { ready(); },
        address: () => ({ port: served.port }),
        close: (done: () => void) => { served.closed += 1; done(); },
      };
    },
  },
  };
});

vi.mock('../lib/test-database.js', () => ({ testDatabase: async () => memoryDatabase(), emptiedEachTime: async () => async () => memoryDatabase() }));

interface Answer { status: number; body: unknown }

function ask(path: string): Promise<Answer> {
  return new Promise((done) => {
    const request = Object.assign(new IncomingMessage(new Socket()), { method: 'GET', url: path, headers: {} });
    const response = new ServerResponse(request);
    response.end = ((chunk?: unknown) => {
      done({ status: response.statusCode, body: JSON.parse(String(chunk)) as unknown });
      return response;
    }) as typeof response.end;
    served.app?.(request, response);
  });
}

const probeRouter = () => {
  const r = Router();
  r.get('/me', (req, res) => res.json({ id: principalFrom(req).id, roles: principalFrom(req).claims }));
  r.get('/boom', () => { throw new Error('deliberate'); });
  return r;
};

let harness: Harness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

describe('the router test harness', () => {
  it('mounts a router under its prefix and says where it listens', async () => {
    harness = await mountRouter({ prefix: '/api/probe', router: () => probeRouter() });
    expect(harness.url('/api/probe/me')).toBe('http://localhost:4321/api/probe/me');
    const answer = await ask('/api/probe/me');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ id: TEST_USER.id });
  });

  it('gives the router a database to build on', async () => {
    let given: unknown;
    harness = await mountRouter({ prefix: '/p', router: (db) => { given = db; return probeRouter(); } });
    expect(given).toBe(harness.db);
  });

  it('refuses when there is no user, so a route suite can assert its 401 path', async () => {
    harness = await mountRouter({ prefix: '/api/probe', router: () => probeRouter(), user: null });
    expect(await ask('/api/probe/me')).toEqual({ status: 401, body: { error: 'Session missing' } });
  });

  it('can change who is signed in mid-test, which is how cross-tenant reads get checked', async () => {
    harness = await mountRouter({ prefix: '/api/probe', router: () => probeRouter() });
    harness.setUser({ id: 'someone-else', email: 'other@example.com' });
    expect((await ask('/api/probe/me')).body).toMatchObject({ id: 'someone-else' });
    harness.setUser(null);
    expect((await ask('/api/probe/me')).status).toBe(401);
  });

  it('turns a thrown handler into an error body, not a hung request', async () => {
    harness = await mountRouter({ prefix: '/api/probe', router: () => probeRouter() });
    expect(await ask('/api/probe/boom')).toEqual({ status: 500, body: { error: 'deliberate' } });
  });

  it('stops listening when closed', async () => {
    served.closed = 0;
    harness = await mountRouter({ prefix: '/api/probe', router: () => probeRouter() });
    await harness.close();
    harness = undefined;
    expect(served.closed).toBe(1);
  });
});
