import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { authRouter } from './auth.js';
import { createAuth } from '../middleware/auth.js';
import { createDatabase } from '../lib/db-interface.js';
import type { Database } from '../lib/db-interface.js';
import { AuthService } from '../services/AuthService.js';

/**
 * The auth router over its REAL middleware.
 *
 * ── WHY NOT `routes/test-harness.ts` ──
 * Every other router test mounts a stub that puts a user on the request, because a route's job is
 * what it does once a caller is established. This router's job IS establishing the caller, so a
 * stub would test nothing: the interesting behaviour is that `/login` mints a cookie which
 * `requireAuth` then accepts, and that the public-path allow-list lets `/register` through while
 * `/me` stays closed. Both halves have to be the production ones for that to mean anything.
 *
 * The wiring below mirrors `bootstrap()` exactly — `app.use('/api', requireAuth)` before
 * `app.use('/api/auth', authRouter(...))`. If that order ever inverts in index.ts, this file keeps
 * passing and the server stops being protected, which is why `routes.test.ts` still boots the real
 * application too.
 */

const JWT_SECRET = 'test-secret';

async function serve(db: Database) {
  const auth = createAuth({ db, jwtSecret: JWT_SECRET, publicUrl: 'http://localhost:3001' });
  const app = express();
  app.use(express.json());
  app.use('/api', auth.requireAuth);
  app.use('/api/auth', authRouter({
    db,
    authService: new AuthService(db),
    auth,
    jwtSecret: JWT_SECRET,
    publicUrl: 'http://localhost:3001',
    appUrl: 'http://localhost:5173',
  }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { server, url: (p: string) => `http://127.0.0.1:${port}${p}` };
}

describe('auth router', () => {
  let db: Database;
  let ctx: Awaited<ReturnType<typeof serve>>;
  // IS_E2E short-circuits requireAuth to a mock user. The dev shell exports it, and with it set
  // every assertion below about being signed out silently inverts.
  const wasE2E = process.env.IS_E2E;

  beforeEach(async () => {
    delete process.env.IS_E2E;
    db = createDatabase();
    await db.init();
    ctx = await serve(db);
  });

  afterEach(async () => {
    if (wasE2E !== undefined) process.env.IS_E2E = wasE2E;
    await new Promise<void>((r) => ctx.server.close(() => r()));
  });

  /** Registers and returns the `session` cookie, which is what every later request needs. */
  async function registerAndLogin(email: string, password: string) {
    const reg = await fetch(ctx.url('/api/auth/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(reg.status).toBe(200);
    const login = await fetch(ctx.url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const cookie = login.headers.get('set-cookie') ?? '';
    return { login, session: cookie.split(';')[0] ?? '' };
  }

  it('registers, logs in and returns the caller from the minted cookie', async () => {
    const { login, session } = await registerAndLogin('first@example.com', 'hunter2hunter2');
    expect(login.status).toBe(200);
    expect(session).toMatch(/^session=/);

    const me = await fetch(ctx.url('/api/auth/me'), { headers: { cookie: session } });
    expect(me.status).toBe(200);
    expect((await me.json() as { email: string }).email).toBe('first@example.com');
  });

  it('makes the first user an admin and nobody after them', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    const second = await fetch(ctx.url('/api/auth/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'second@example.com', password: 'hunter2hunter2' }),
    });
    // No invite exists, so the second registration is refused outright — the platform can spend
    // real money via cloud APIs, so an open registration endpoint is the whole risk.
    expect(second.status).toBe(403);
    expect((await second.json() as { error: string }).error).toMatch(/invite code is required/i);

    const first = await db.getUserByEmail('first@example.com');
    expect(first?.isAdmin).toBe(true);
  });

  it('consumes an invite exactly once', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.saveInvite({ code: 'LETMEIN', createdAt: new Date().toISOString() } as never);

    const ok = await fetch(ctx.url('/api/auth/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'second@example.com', password: 'hunter2hunter2', inviteCode: 'LETMEIN' }),
    });
    expect(ok.status).toBe(200);
    expect((await db.getUserByEmail('second@example.com'))?.isAdmin).toBeUndefined();

    const reuse = await fetch(ctx.url('/api/auth/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'third@example.com', password: 'hunter2hunter2', inviteCode: 'LETMEIN' }),
    });
    expect(reuse.status).toBe(403);
    expect((await reuse.json() as { error: string }).error).toMatch(/already been used/i);
  });

  /**
   * The bug this pins: registration stored the email as typed while every read path normalises,
   * so a capital letter made the account unreachable forever with "Invalid email or password".
   */
  it('normalises the email on registration so login can find it again', async () => {
    await fetch(ctx.url('/api/auth/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: '  MixedCase@Example.COM ', password: 'hunter2hunter2' }),
    });
    // Asserted on the STORED value, not just on login succeeding. MemoryDB used to normalise both
    // sides of the comparison while Mongo normalises only the query, so a login-only assertion
    // passed with the normalisation deleted — verified by mutation.
    expect((await db.getUsers())[0]?.email).toBe('mixedcase@example.com');

    const login = await fetch(ctx.url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mixedcase@example.com', password: 'hunter2hunter2' }),
    });
    expect(login.status).toBe(200);
  });

  it('refuses a wrong password without revealing whether the account exists', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    const wrongPass = await fetch(ctx.url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'first@example.com', password: 'wrong-password' }),
    });
    const noSuchUser = await fetch(ctx.url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' }),
    });
    expect(wrongPass.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(await wrongPass.json()).toEqual(await noSuchUser.json());
  });

  it('keeps /me closed while /login and /register stay open', async () => {
    const me = await fetch(ctx.url('/api/auth/me'));
    expect(me.status).toBe(401);

    // Reached the handler rather than the guard: 400 is the router's own "missing fields".
    const login = await fetch(ctx.url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(login.status).toBe(400);
  });

  it('clears the session on logout with flags that match how it was set', async () => {
    const { session } = await registerAndLogin('first@example.com', 'hunter2hunter2');
    const out = await fetch(ctx.url('/api/auth/logout'), {
      method: 'POST',
      headers: { cookie: session },
    });
    expect(out.status).toBe(200);
    // A clearCookie whose flags differ from the set leaves the original cookie in the browser.
    const cleared = out.headers.get('set-cookie') ?? '';
    expect(cleared).toMatch(/^session=;/);
    expect(cleared).toMatch(/HttpOnly/i);
    expect(cleared).toMatch(/SameSite=Lax/i);
  });

  it('rejects a session signed with the wrong secret', async () => {
    const { session } = await registerAndLogin('first@example.com', 'hunter2hunter2');
    const forged = session.replace(/\.[^.]+$/, '.not-the-right-signature');
    const me = await fetch(ctx.url('/api/auth/me'), { headers: { cookie: forged } });
    expect(me.status).toBe(401);
  });
});
