import { describe, it, expect, afterEach } from 'vitest';
import { Router } from 'express';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';

/**
 * The harness, tested against a throwaway router.
 *
 * A test harness with no test is a claim rather than a tool: every route suite written from here on
 * inherits whatever is wrong with it, and a harness bug looks exactly like a route bug. These are
 * the four properties the route suites will actually depend on.
 */

let h: Harness | undefined;
axios.defaults.proxy = false;
afterEach(async () => { await h?.close(); h = undefined; });

/** Exercises the request user, the database, a thrown error and a non-GET verb. */
const probeRouter = () => {
  const r = Router();
  r.get('/me', (req, res) => res.json({ id: (req as never as { user: { id: string } }).user.id }));
  r.get('/boom', () => { throw new Error('deliberate'); });
  r.post('/echo', (req, res) => res.status(201).json({ got: req.body }));
  return r;
};

describe('the router test harness', () => {
  it('mounts a router and reaches it over real HTTP', async () => {
    h = await mountRouter({ prefix: '/api/probe', router: () => probeRouter() });
    const res = await axios.get(h.url('/api/probe/me'));
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(TEST_USER.id);
  });

  it('refuses when there is no user, so a route suite can assert its 401 path', async () => {
    h = await mountRouter({ prefix: '/api/probe', router: () => probeRouter(), user: null });
    await expect(axios.get(h.url('/api/probe/me'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('can change tenant mid-test, which is how cross-tenant reads get checked', async () => {
    // The whole reason `setUser` exists: "alice cannot read bob's record" needs both users in one
    // test, and re-mounting between them would lose the database that made the record.
    h = await mountRouter({ prefix: '/api/probe', router: () => probeRouter() });
    h.setUser({ id: 'someone-else', email: 'other@example.com', isAdmin: false });
    expect((await axios.get(h.url('/api/probe/me'))).data.id).toBe('someone-else');
  });

  it('turns a thrown handler into a 500 with a body, not a hung socket', async () => {
    // Otherwise a route that throws reports as a test timeout, which sends you looking in the
    // wrong place entirely.
    h = await mountRouter({ prefix: '/api/probe', router: () => probeRouter() });
    await expect(axios.get(h.url('/api/probe/boom'))).rejects.toMatchObject({
      response: { status: 500, data: { error: 'deliberate' } },
    });
  });

  it('parses a JSON body, since most routes worth testing take one', async () => {
    h = await mountRouter({ prefix: '/api/probe', router: () => probeRouter() });
    const res = await axios.post(h.url('/api/probe/echo'), { hello: 'world' });
    expect(res.status).toBe(201);
    expect(res.data.got).toEqual({ hello: 'world' });
  });

  it('hands the router a working database', async () => {
    // `createDatabase()` under NODE_ENV=test is MemoryDB — a real implementation of the real
    // interface, not a stub that can drift from it.
    h = await mountRouter({
      prefix: '/api/probe',
      router: (db) => {
        const r = Router();
        r.get('/count', async (_req, res) => res.json({ n: (await db.getProjects()).length }));
        return r;
      },
    });
    expect((await axios.get(h.url('/api/probe/count'))).data).toEqual({ n: 0 });
  });
});
