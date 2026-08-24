import { describe, it, expect } from 'vitest';
import { parseCookie, createAuth } from './auth.js';
import { createDatabase } from '../lib/db-interface.js';
import { signJWT } from '../lib/auth.js';
import type { Request, Response } from 'express';

/**
 * The guards themselves, apart from any route.
 *
 * `routes/auth.test.ts` proves the login → cookie → `requireAuth` round-trip over real HTTP. This
 * file covers the edges that are awkward to reach that way: a malformed Cookie header, a token for
 * a user who has since been deleted, and the admin gate.
 */

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

  /**
   * A name that is a PREFIX of another must not match it. `parseCookie` splits on `=` and compares
   * the whole key, so `sess` never picks up `session` — the failure mode would be silently
   * authenticating with the wrong value.
   */
  it('does not match a cookie whose name merely starts the same', () => {
    expect(parseCookie('session_backup=xyz', 'session')).toBeUndefined();
  });
});

/** Enough of an Express req/res to drive a guard, with the status recorded. */
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
  const jwtSecret = 'test-secret';

  async function build() {
    const db = createDatabase();
    await db.init();
    return { db, auth: createAuth({ db, jwtSecret, publicUrl: 'http://localhost:3001' }) };
  }

  it('refuses a request with no session cookie', async () => {
    const { auth } = await build();
    const c = fakeCall();
    await auth.requireAuth(c.req, c.res, c.next);
    expect(c.result().statusCode).toBe(401);
    expect(c.result().nexted).toBe(false);
  });

  /**
   * The token verifies, the user is gone. Deleting an account has to end its live sessions, and a
   * guard that trusted the signature alone would keep them working until the JWT expired.
   */
  it('refuses a validly-signed token for a user who no longer exists', async () => {
    const { auth } = await build();
    const token = signJWT({ userId: 'deleted-user' }, jwtSecret, 3600);
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
    const token = signJWT({ userId: 'u1' }, jwtSecret, 3600);
    const c = fakeCall({ cookie: `session=${token}` });
    await auth.requireAuth(c.req, c.res, c.next);
    expect(c.result().nexted).toBe(true);
    expect((c.result().user as { email: string }).email).toBe('u1@example.com');
  });

  /**
   * The Socket.IO handshake and `requireAuth` MUST accept the same credential — a socket that
   * resolved a user the HTTP API would reject is a way around every route guard. They share
   * `userFromSessionCookie` precisely so this cannot drift; this asserts they still agree.
   */
  it('resolves the same user the socket handshake would', async () => {
    const { db, auth } = await build();
    await db.saveUser({ id: 'u1', email: 'u1@example.com', createdAt: new Date().toISOString() } as never);
    const token = signJWT({ userId: 'u1' }, jwtSecret, 3600);

    const c = fakeCall({ cookie: `session=${token}` });
    await auth.requireAuth(c.req, c.res, c.next);
    const viaSocket = await auth.userFromSessionCookie(`session=${token}`);

    expect(viaSocket?.id).toBe((c.result().user as { id: string }).id);
    expect(await auth.userFromSessionCookie('session=garbage')).toBeUndefined();
  });
});

describe('requireAdmin', () => {
  const auth = createAuth({
    db: null as never, jwtSecret: 'x', publicUrl: 'http://localhost:3001',
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
  /**
   * `secure` was hardcoded false, which over HTTPS means the session travels in cleartext to
   * anyone who can force one plain-http request. It cannot be hardcoded true either — dev has no
   * TLS and the browser would simply never store the cookie.
   */
  it('marks the cookie secure only when the public origin is https', () => {
    const db = null as never;
    expect(createAuth({ db, jwtSecret: 'x', publicUrl: 'https://app.example.com' })
      .sessionCookieOptions.secure).toBe(true);
    expect(createAuth({ db, jwtSecret: 'x', publicUrl: 'http://localhost:3001' })
      .sessionCookieOptions.secure).toBe(false);
  });

  it('is httpOnly and lax in both cases', () => {
    for (const url of ['https://app.example.com', 'http://localhost:3001']) {
      const opts = createAuth({ db: null as never, jwtSecret: 'x', publicUrl: url }).sessionCookieOptions;
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe('lax');
    }
  });
});
