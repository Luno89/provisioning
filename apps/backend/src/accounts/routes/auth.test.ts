import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { authRouter } from './auth.js';
import { createAuth } from '../../platform/middleware/auth.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { AuthService } from '../services/AuthService.js';

const JWT_SECRET = 'test-secret';

async function serve(db: Database) {
  const auth = createAuth({ db, sessionKey: JWT_SECRET, publicUrl: 'http://localhost:3001' });
  const authService = new AuthService(db);
  const app = express();
  app.use(express.json());
  app.use('/api', auth.requireAuth);
  app.use('/api/auth', authRouter({
    db,
    authService,
    auth,
    sessionKey: JWT_SECRET,
    publicUrl: 'http://localhost:3001',
    appUrl: 'http://localhost:5173',
  }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { server, authService, url: (p: string) => `http://127.0.0.1:${port}${p}` };
}

describe('auth router', () => {
  let db: Database;
  let ctx: Awaited<ReturnType<typeof serve>>;
  const wasE2E = process.env.IS_E2E;

  beforeEach(async () => {
    delete process.env.IS_E2E;
    db = await testDatabase();
    await db.init();
    ctx = await serve(db);
  });

  afterEach(async () => {
    if (wasE2E !== undefined) process.env.IS_E2E = wasE2E;
    await new Promise<void>((r) => ctx.server.close(() => r()));
  });

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

  it('locks an account after ten wrong passwords in a row, and the right one after that is refused too', async () => {
    await registerAndLogin('locked@example.com', 'hunter2hunter2');
    const attempt = (password: string) => fetch(ctx.url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'Locked@example.com', password }) });
    for (let n = 0; n < 10; n += 1) expect((await attempt('wrong')).status).toBe(401);
    const locked = await attempt('hunter2hunter2');
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as { error: string }).error).toMatch(/try again in 15 minutes/);
    expect((await fetch(ctx.url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'other@example.com', password: 'x' }) })).status).toBe(401);
  });

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
    expect(second.status).toBe(403);
    expect((await second.json() as { error: string }).error).toMatch(/invite code is required/i);

    const first = await db.accounts.getUserByEmail('first@example.com');
    expect(first?.isAdmin).toBe(true);
  });

  it('consumes an invite exactly once', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.accounts.saveInvite({ id: 'inv-letmein', code: 'LETMEIN', createdAt: new Date().toISOString() } as never);

    const ok = await fetch(ctx.url('/api/auth/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'second@example.com', password: 'hunter2hunter2', inviteCode: 'LETMEIN' }),
    });
    expect(ok.status).toBe(200);
    expect((await db.accounts.getUserByEmail('second@example.com'))?.isAdmin).toBeUndefined();

    const reuse = await fetch(ctx.url('/api/auth/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'third@example.com', password: 'hunter2hunter2', inviteCode: 'LETMEIN' }),
    });
    expect(reuse.status).toBe(403);
    expect((await reuse.json() as { error: string }).error).toMatch(/already been used/i);
  });

  it('lets only one of two sign-ups at the same moment use an invite', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.accounts.saveInvite({ id: 'inv-once', code: 'ONCE', createdAt: new Date().toISOString() } as never);
    const signUp = (email: string) => fetch(ctx.url('/api/auth/register'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'hunter2hunter2', inviteCode: 'ONCE' }),
    });
    const both = await Promise.all([signUp('a@example.com'), signUp('b@example.com'), signUp('c@example.com')]);
    expect(both.map((response) => response.status).sort()).toEqual([200, 403, 403]);
  });

  it('asks for a code against a signed challenge, ends it after five wrong codes, and never takes the challenge as a session', async () => {
    const { session } = await registerAndLogin('two@example.com', 'hunter2hunter2');
    const on = await fetch(ctx.url('/api/auth/2fa/settings'), { method: 'POST', headers: { 'content-type': 'application/json', cookie: session }, body: JSON.stringify({ enabled: true, preferredMethod: 'email' }) });
    expect(on.status).toBe(200);
    vi.spyOn(ctx.authService, 'send2FACode').mockResolvedValue(undefined);
    const issued = vi.spyOn(ctx.authService, 'create2FAChallenge');
    const signIn = async () => {
      const answer = await (await fetch(ctx.url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'two@example.com', password: 'hunter2hunter2' }) })).json() as { twoFactorRequired: boolean; challenge: string; userId?: string };
      return { ...answer, code: issued.mock.results.at(-1)!.value as string };
    };
    const verify = (challenge: string, code: string) => fetch(ctx.url('/api/auth/2fa/verify'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge, code }) });

    const first = await signIn();
    expect(first.twoFactorRequired).toBe(true);
    expect(first.userId).toBeUndefined();
    expect((await fetch(ctx.url('/api/auth/me'), { headers: { cookie: `session=${first.challenge}` } })).status).toBe(401);
    expect((await verify('not-a-challenge', first.code)).status).toBe(400);
    const wrong = first.code === '000000' ? '111111' : '000000';
    for (let n = 0; n < 5; n += 1) expect((await verify(first.challenge, wrong)).status).toBe(400);
    expect((await verify(first.challenge, first.code)).status).toBe(400);

    const second = await signIn();
    const passed = await verify(second.challenge, second.code);
    expect(passed.status).toBe(200);
    expect(passed.headers.get('set-cookie')).toMatch(/^session=/);
  });

  it('takes a GitHub sign-in back only from the browser that started it', async () => {
    const was = process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_ID;
    try {
      const started = await fetch(ctx.url('/api/auth/github'), { redirect: 'manual' });
      const back = new URL(started.headers.get('location')!);
      const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0]!;
      expect(cookie).toMatch(/^oauth_state=/);
      expect(back.searchParams.get('state')).toMatch(/^[\w-]{32}$/);

      const elsewhere = await fetch(ctx.url(`${back.pathname}${back.search}`), { redirect: 'manual' });
      expect(elsewhere.headers.get('location')).toContain('authError=');
      expect(elsewhere.headers.get('set-cookie') ?? '').not.toMatch(/session=[^;]/);

      const here = await fetch(ctx.url(`${back.pathname}${back.search}`), { redirect: 'manual', headers: { cookie } });
      expect(here.headers.get('location')).toBe('http://localhost:5173/');
      expect(here.headers.get('set-cookie')).toMatch(/session=[^;]/);
    } finally {
      if (was !== undefined) process.env.GITHUB_CLIENT_ID = was;
    }
  });

  it('normalises the email on registration so login can find it again', async () => {
    await fetch(ctx.url('/api/auth/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: '  MixedCase@Example.COM ', password: 'hunter2hunter2' }),
    });
    expect((await db.accounts.getUsers())[0]?.email).toBe('mixedcase@example.com');

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
