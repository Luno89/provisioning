import { describe, it, expect } from 'vitest';
import { parseCookie, createAuth } from './auth.js';
import { createDatabase } from '../lib/db-interface.js';
import { signJWT } from '../lib/auth.js';
import type { Request, Response } from 'express';

describe('parseCookie', () => {
  it('finds a cookie among others regardless of spacing', () => {
    expect(parseCookie('theme=dark; session=abc; lang=en', 'session')).toBe('abc');
    expect(parseCookie('session=abc', 'session')).toBe('abc');
  });

  it('answers undefined rather than throwing on nothing to parse', () => {
    expect(parseCookie(undefined, 'session')).toBeUndefined();
    expect(parseCookie('', 'session')).toBeUndefined();
    expect(parseCookie('theme=dark', 'session')).toBeUndefined();
  });

  it('does not match a cookie whose name merely starts the same', () => {
    expect(parseCookie('session_backup=xyz', 'session')).toBeUndefined();
  });
});

function fakeCall(headers: Record<string, string> = {}) {
  let statusCode = 0;
  let body: unknown;
  let nexted = false;
  const req = { headers, path: '/anything', user: undefined } as unknown as Request;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(payload: unknown) { body = payload; return this; },
  } as unknown as Response;
  return {
    req, res,
    next: () => { nexted = true; },
    result: () => ({ statusCode, body, nexted, user: (req as unknown as { user: unknown }).user }),
  };
}

describe('requireAuth', () => {
  const sessionKey = 'test-secret';

  async function build() {
    const db = createDatabase();
    await db.init();
    return { db, auth: createAuth({ db, sessionKey, publicUrl: 'http://localhost:3001' }) };
  }

  it('refuses a request with no session cookie', async () => {
    const { auth } = await build();
    const c = fakeCall();
    await auth.requireAuth(c.req, c.res, c.next);
    expect(c.result().statusCode).toBe(401);
    expect(c.result().nexted).toBe(false);
  });

  it('refuses a validly-signed token for a user who no longer exists', async () => {
    const { auth } = await build();
    const token = signJWT({ userId: 'deleted-user' }, sessionKey, 3600);
    const c = fakeCall({ cookie: `session=${token}` });
    await auth.requireAuth(c.req, c.res, c.next);
    expect(c.result().statusCode).toBe(401);
  });

  it('refuses a token signed with a different secret', async () => {
    const { db, auth } = await build();
    await db.saveUser({ id: 'u1', email: 'u1@example.com', createdAt: new Date().toISOString() } as never);
    const token = signJWT({ userId: 'u1' }, 'not-the-secret', 3600);
    const c = fakeCall({ cookie: `session=${token}` });
    await auth.requireAuth(c.req, c.res, c.next);
    expect(c.result().statusCode).toBe(401);
  });

  it('puts the resolved user on the request and continues', async () => {
    const { db, auth } = await build();
    await db.saveUser({ id: 'u1', email: 'u1@example.com', createdAt: new Date().toISOString() } as never);
    const token = signJWT({ userId: 'u1' }, sessionKey, 3600);
    const c = fakeCall({ cookie: `session=${token}` });
    await auth.requireAuth(c.req, c.res, c.next);
    expect(c.result().nexted).toBe(true);
    expect((c.result().user as { email: string }).email).toBe('u1@example.com');
  });

  it('resolves the same user the socket handshake would', async () => {
    const { db, auth } = await build();
    await db.saveUser({ id: 'u1', email: 'u1@example.com', createdAt: new Date().toISOString() } as never);
    const token = signJWT({ userId: 'u1' }, sessionKey, 3600);

    const c = fakeCall({ cookie: `session=${token}` });
    await auth.requireAuth(c.req, c.res, c.next);
    const viaSocket = await auth.userFromSessionCookie(`session=${token}`);

    expect(viaSocket?.id).toBe((c.result().user as { id: string }).id);
    expect(await auth.userFromSessionCookie('session=garbage')).toBeUndefined();
  });
});

describe('requireAdmin', () => {
  const auth = createAuth({
    db: null as never, sessionKey: 'x', publicUrl: 'http://localhost:3001',
  });

  it('refuses a signed-in non-admin with 403, not 401', async () => {
    const c = fakeCall();
    (c.req as unknown as { user: unknown }).user = { id: 'u1', isAdmin: false };
    auth.requireAdmin(c.req, c.res, c.next);
    expect(c.result().statusCode).toBe(403);
  });

  it('refuses when there is no user at all', async () => {
    const c = fakeCall();
    auth.requireAdmin(c.req, c.res, c.next);
    expect(c.result().statusCode).toBe(403);
  });

  it('admits an admin', async () => {
    const c = fakeCall();
    (c.req as unknown as { user: unknown }).user = { id: 'u1', isAdmin: true };
    auth.requireAdmin(c.req, c.res, c.next);
    expect(c.result().nexted).toBe(true);
  });
});

describe('session cookie flags', () => {
  it('marks the cookie secure only when the public origin is https', () => {
    const db = null as never;
    expect(createAuth({ db, sessionKey: 'x', publicUrl: 'https://app.example.com' })
      .sessionCookieOptions.secure).toBe(true);
    expect(createAuth({ db, sessionKey: 'x', publicUrl: 'http://localhost:3001' })
      .sessionCookieOptions.secure).toBe(false);
  });

  it('is httpOnly and lax in both cases', () => {
    for (const url of ['https://app.example.com', 'http://localhost:3001']) {
      const opts = createAuth({ db: null as never, sessionKey: 'x', publicUrl: url }).sessionCookieOptions;
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe('lax');
    }
  });
});

describe('what is open without a session, by role', () => {
  const at = (path: string) => {
    const call = fakeCall();
    (call.req as unknown as { path: string }).path = path;
    return call;
  };
  const opens = async (role: 'root' | 'instance' | 'combined', path: string): Promise<boolean> => {
    const db = createDatabase();
    await db.init();
    const call = at(path);
    await createAuth({ db, sessionKey: 'k', publicUrl: 'http://localhost:3001', role }).requireAuth(call.req, call.res, call.next);
    return call.result().nexted;
  };

  it('lets anyone reach an instance\'s sign-in exchange, and nothing of root\'s sign-in', async () => {
    expect(await opens('instance', '/auth/handoff')).toBe(true);
    expect(await opens('instance', '/auth/sign-in')).toBe(true);
    expect(await opens('instance', '/auth/login')).toBe(false);
    expect(await opens('instance', '/auth/github/callback')).toBe(false);
    expect(await opens('instance', '/identity/keys')).toBe(false);
  });

  it('keeps root\'s sign-in and public keys open, and an instance\'s exchange closed', async () => {
    expect(await opens('root', '/auth/login')).toBe(true);
    expect(await opens('root', '/identity/keys')).toBe(true);
    expect(await opens('root', '/identity/go')).toBe(true);
    expect(await opens('instance', '/identity/go')).toBe(false);
    expect(await opens('root', '/auth/handoff')).toBe(false);
    expect(await opens('combined', '/auth/login')).toBe(true);
    expect(await opens('combined', '/auth/handoff')).toBe(false);
  });

  it('marks an instance\'s session cookie Secure only when the request really came over https', async () => {
    const db = createDatabase();
    await db.init();
    const auth = createAuth({ db, sessionKey: 'k', publicUrl: 'http://localhost:3001', role: 'instance' });
    const cookies: Array<{ secure: boolean }> = [];
    const res = { cookie: (_name: string, _value: string, options: { secure: boolean }) => { cookies.push(options); } } as unknown as Response;

    auth.setSessionCookie(res, 't', { secure: false, headers: { 'x-forwarded-proto': 'https' } } as unknown as Request);
    auth.setSessionCookie(res, 't', { secure: false, headers: {} } as unknown as Request);

    expect(cookies.map((cookie) => cookie.secure)).toEqual([true, false]);
  });
});
