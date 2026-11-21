import { describe, it, expect } from 'vitest';
import express, { type Request, type Response } from 'express';
import { parseCookie, createAuth } from './auth.js';
import { testDatabase } from '../lib/test-database.js';
import type { Database } from '../lib/db-interface.js';
import { BrowserSessions } from '../services/BrowserSessions.js';
import { memoryDatabase } from '../testing/memory-database.js';
import { rootAuthOver } from '../testing/root-auth.js';
import { serveInProcess } from '../../instances/testing/serve-in-process.js';
import { inviteCodeHash } from '../lib/invite-codes.js';
import { openRoutesOf } from '../../open-routes.js';

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

function rootServed(db: Database, publicUrl = 'http://localhost:3001') {
  const world = rootAuthOver(db, { publicUrl, open: openRoutesOf('root') });
  const app = express();
  app.post('/hold/:id', (req, res, next) => {
    db.accounts.getUserById(String(req.params.id)).then(async (user) => {
      if (!user) throw new Error(`no account ${String(req.params.id)} to sign in`);
      await world.auth.holdAccount(req, user);
      res.json({ held: true });
    }).catch(next);
  });
  app.post('/out', (req, res, next) => { world.auth.endSession(req).then(() => { world.auth.clearSession(res); res.json({}); }, next); });
  app.get('/socket', world.auth.sessionHandle, (req, res, next) => { world.auth.sessionOf(req).then((held) => res.json({ id: held?.user.id ?? null }), next); });
  app.use('/api', world.auth.requireAuth);
  app.get('/api/me', (req, res) => { res.json({ id: (req as { user?: { id: string } }).user?.id }); });
  const ask = async (method: string, path: string, cookie?: string, https = publicUrl.startsWith('https://')) => {
    const answer = await serveInProcess(app, new Request(`http://koala.test${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(https ? { 'x-forwarded-proto': 'https' } : {}) } }));
    const set = answer.headers.getSetCookie();
    return { status: answer.status, body: await answer.json() as Record<string, unknown>, set, cookie: set[0]?.split(';')[0] };
  };
  const signIn = async (id: string): Promise<string> => {
    const held = await ask('POST', `/hold/${id}`);
    if (!held.cookie) throw new Error(`signing ${id} in set no cookie`);
    return held.cookie;
  };
  return { ...world, ask, signIn };
}

describe('requireAuth on root', () => {
  async function build() {
    const db = await testDatabase();
    await db.init();
    await db.accounts.saveUser({ id: 'u1', email: 'u1@example.com', createdAt: new Date().toISOString() } as never);
    await db.accounts.saveUser({ id: 'u2', email: 'u2@example.com', createdAt: new Date().toISOString() } as never);
    return { db, root: rootServed(db) };
  }

  it('refuses a request with no session cookie', async () => {
    const { root } = await build();
    const asked = await root.ask('GET', '/api/me');
    expect(asked.status).toBe(401);
    expect(asked.body).toEqual({ error: 'Unauthorized: Session missing' });
  });

  it('refuses a cookie the session store never made, however it is named or signed', async () => {
    const { root } = await build();
    expect((await root.ask('GET', '/api/me', 'koala_sid=s%3Aforged.signature')).status).toBe(401);
    expect((await root.ask('GET', '/api/me', 'session=anything')).status).toBe(401);
    expect((await root.ask('GET', '/socket', 'koala_sid=s%3Aforged.signature')).body).toEqual({ id: null });
  });

  it('holds only an id in the cookie, puts the account on the request, and the socket handshake resolves the same account', async () => {
    const { root } = await build();
    const cookie = await root.signIn('u1');
    expect(cookie).toMatch(/^koala_sid=s%3A/);
    expect(cookie).not.toContain('u1');
    expect((await root.ask('GET', '/api/me', cookie)).body).toEqual({ id: 'u1' });
    expect((await root.ask('GET', '/socket', cookie)).body).toEqual({ id: 'u1' });
  });

  it('refuses a held session whose account no longer exists or is being removed, for requests and sockets alike', async () => {
    const { db, root } = await build();
    const gone = await root.signIn('u1');
    const leaving = await root.signIn('u2');
    await db.accounts.deleteUser('u1');
    await db.accounts.saveUser({ id: 'u2', email: 'u2@example.com', createdAt: new Date().toISOString(), removal: { startedAt: 'now', requestedBy: 'u2' } } as never);
    for (const cookie of [gone, leaving]) {
      expect((await root.ask('GET', '/api/me', cookie)).body).toEqual({ error: 'Unauthorized: Session invalid or expired' });
      expect((await root.ask('GET', '/socket', cookie)).body).toEqual({ id: null });
    }
  });

  it('refuses a session signed out of, in this process and in another, while the account\'s other sessions go on', async () => {
    const { db, root } = await build();
    const left = await root.signIn('u1');
    const kept = await root.signIn('u1');
    const ended: string[] = [];
    root.sessions.onEnd((sid) => ended.push(sid));
    await root.ask('POST', '/out', left);
    expect(ended).toHaveLength(1);
    expect((await root.ask('GET', '/api/me', left)).status).toBe(401);
    expect((await root.ask('GET', '/socket', left)).body).toEqual({ id: null });
    expect((await root.ask('GET', '/api/me', kept)).body).toEqual({ id: 'u1' });
    const another = rootServed(db);
    expect((await another.ask('GET', '/api/me', left)).status).toBe(401);
    expect((await another.ask('GET', '/api/me', kept)).body).toEqual({ id: 'u1' });
  });

  it('ends every session of a person at once when their access is revoked, and only theirs', async () => {
    const { root } = await build();
    const one = await root.signIn('u1');
    const two = await root.signIn('u1');
    const theirs = await root.signIn('u2');
    const ended: string[] = [];
    root.sessions.onEnd((sid) => ended.push(sid));
    expect(await root.revocations.revoked({ personId: 'u1', because: 'signed-out-everywhere', at: new Date().toISOString() })).toEqual([]);
    expect(ended).toHaveLength(2);
    expect((await root.ask('GET', '/api/me', one)).status).toBe(401);
    expect((await root.ask('GET', '/api/me', two)).status).toBe(401);
    expect((await root.ask('GET', '/api/me', theirs)).body).toEqual({ id: 'u2' });
  });
});

describe('requireAdmin', () => {
  const { auth } = rootAuthOver(memoryDatabase(), { open: openRoutesOf('root') });

  it('refuses a signed-in non-admin with 403, not 401', async () => {
    const c = fakeCall();
    (c.req as unknown as { principal: unknown }).principal = auth.principalFor({ id: 'u1' });
    auth.requireOperator('administer')(c.req, c.res, c.next);
    expect(c.result().statusCode).toBe(403);
  });

  it('refuses when there is no user at all', async () => {
    const c = fakeCall();
    auth.requireOperator('administer')(c.req, c.res, c.next);
    expect(c.result().statusCode).toBe(403);
  });

  it('admits an admin', async () => {
    const c = fakeCall();
    (c.req as unknown as { principal: unknown }).principal = auth.principalFor({ id: 'u1', roles: ['operator' as const] });
    auth.requireOperator('administer')(c.req, c.res, c.next);
    expect(c.result().nexted).toBe(true);
  });
});

describe('session cookie flags', () => {
  it('marks the cookie secure only when the public origin is https', () => {
    expect(rootAuthOver(memoryDatabase(), { publicUrl: 'https://app.example.com', open: openRoutesOf('root') }).auth.sessionCookieOptions.secure).toBe(true);
    expect(rootAuthOver(memoryDatabase(), { publicUrl: 'http://localhost:3001', open: openRoutesOf('root') }).auth.sessionCookieOptions.secure).toBe(false);
  });

  it('is httpOnly and lax in both cases', () => {
    for (const url of ['https://app.example.com', 'http://localhost:3001']) {
      const opts = rootAuthOver(memoryDatabase(), { publicUrl: url, open: openRoutesOf('root') }).auth.sessionCookieOptions;
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe('lax');
    }
  });
});

describe('what is open without a session, by role', () => {
  const at = (path: string) => {
    const call = fakeCall();
    Object.assign(call.req, { path, url: path, method: 'GET' });
    return call;
  };
  let opened: Promise<Database> | undefined;
  const database = (): Promise<Database> => {
    opened ??= testDatabase().then(async (db) => { await db.init(); return db; });
    return opened;
  };
  const opens = async (role: 'root' | 'instance', path: string): Promise<boolean> => {
    const db = await database();
    const call = at(path);
    const auth = role === 'instance'
      ? createAuth({ db, publicUrl: 'http://localhost:3001', role, open: openRoutesOf(role), throughRoot: { sessions: new BrowserSessions({ store: db.platform, secret: 'k', securedFor: () => false }), signIn: { fresh: () => { throw new Error('no one is signed in here'); }, end: () => { throw new Error('no one is signed in here'); } } } })
      : rootAuthOver(db, { open: openRoutesOf(role) }).auth;
    await auth.requireAuth(call.req, call.res, call.next);
    return call.result().nexted;
  };

  it('lets an instance sign people in only through root, and opens nothing of the archived hub on root', async () => {
    for (const path of ['/auth/oidc/start', '/auth/oidc/callback', '/auth/oidc/backchannel-logout']) expect(await opens('instance', path), path).toBe(true);
    expect(await opens('instance', '/auth/handoff')).toBe(false);
    expect(await opens('instance', '/auth/login')).toBe(false);
    for (const path of ['/hub-link/sign-in-key', '/hub-link/invite', '/hub-link/invitation', '/instances/hub-token']) expect(await opens('root', path), path).toBe(false);
  });

    it('lets anyone open a shared file\'s link, and nothing else of a person\'s files', async () => {
    expect(await opens('instance', '/share/abcdefghijklmnopqrstuvwxyz012345')).toBe(true);
    for (const role of ['instance', 'root'] as const) {
      expect(await opens(role, '/files/shares')).toBe(false);
      expect(await opens(role, '/files/mine/content')).toBe(false);
    }
    expect(await opens('root', '/share/abcdefghijklmnopqrstuvwxyz012345')).toBe(false);
  });

    it('lets anyone reach an instance\'s sign-in through root, and nothing of root\'s own sign-in', async () => {
    for (const path of ['/auth/sign-in', '/auth/oidc/start', '/auth/oidc/callback', '/auth/oidc/backchannel-logout']) expect(await opens('instance', path), path).toBe(true);
    expect(await opens('instance', '/auth/handoff')).toBe(false);
    expect(await opens('instance', '/auth/login')).toBe(false);
    expect(await opens('instance', '/auth/provider/google')).toBe(false);
    expect(await opens('instance', '/auth/provider/google/callback')).toBe(false);
    expect(await opens('instance', '/identity/keys')).toBe(false);
  });

  it('lets an instance reach every route root answers with its credential, which checks it there', async () => {
    for (const path of ['/instances/status', '/instances/release', '/instances/updates', '/instances/release-findings', '/instances/machines', '/instances/machines/join-code', '/instances/machines/m-1', '/instances/watch', '/instances/addresses', '/instances/groups', '/instances/groups/check', '/instances/groups/p1', '/instances/mail']) {
      expect(await opens('root', path), path).toBe(true);
    }
    expect(await opens('root', '/instances/mine')).toBe(false);
  });

  it('keeps root\'s sign-in and public keys open, and an instance\'s exchange closed', async () => {
    expect(await opens('root', '/auth/login')).toBe(true);
    expect(await opens('root', '/identity/keys')).toBe(true);
    expect(await opens('root', '/identity/go')).toBe(true);
    expect(await opens('instance', '/identity/go')).toBe(false);
    expect(await opens('root', '/auth/handoff')).toBe(false);
  });

  it('lets anyone start and finish a provider sign-in where accounts are held, and ask which providers there are', async () => {
    for (const role of ['root'] as const) {
      for (const path of ['/auth/sign-in', '/auth/provider/google', '/auth/provider/google/callback', '/auth/provider/oidc/callback']) expect(await opens(role, path), `${role} ${path}`).toBe(true);
      expect(await opens(role, '/auth/github')).toBe(false);
      expect(await opens(role, '/auth/google/callback')).toBe(false);
    }
  });
});

describe('an invite to sign up', () => {
  const withInvite = async (email?: string) => {
    const db = await testDatabase();
    await db.init();
    await db.accounts.saveInvite({ id: 'i1', codeHash: inviteCodeHash('CODE'), createdBy: 'ann', createdAt: 't', ...(email ? { email } : {}) });
    return { db, auth: rootAuthOver(db, { open: openRoutesOf('root') }).auth };
  };

  it('made for one address signs up only that address, however it is written', async () => {
    const { db, auth } = await withInvite('cy@example.com');
    expect(await auth.checkAndConsumeInvite('CODE', 'u9', false, 'eve@example.com')).toBe('This invite is for cy@example.com; sign up with that address');
    expect((await db.accounts.getInvites())[0]?.usedBy).toBeUndefined();
    expect(await auth.checkAndConsumeInvite('CODE', 'u9', false, ' CY@example.com ')).toBeNull();
    expect((await db.accounts.getInvites())[0]?.usedBy).toBe('u9');
  });

  it('made for anyone still works for anyone, once', async () => {
    const { auth } = await withInvite();
    expect(await auth.checkAndConsumeInvite('CODE', 'u9', false, 'eve@example.com')).toBeNull();
    expect(await auth.checkAndConsumeInvite('CODE', 'u10', false, 'dee@example.com')).toBe('This invite code has already been used');
  });
});

describe('a session over https cannot be planted by a site next door', () => {
  const signedIn = async (publicUrl: string) => {
    const db = await testDatabase();
    await db.init();
    await db.accounts.saveUser({ id: 'u1', email: 'u1@example.com', createdAt: new Date().toISOString() } as never);
    return rootServed(db, publicUrl);
  };

  it('names the cookie __Host-koala_sid over https, which a sibling subdomain cannot set, and takes no plain koala_sid there', async () => {
    const root = await signedIn('https://app.example.com');
    const cookie = await root.signIn('u1');
    expect(cookie).toMatch(/^__Host-koala_sid=s%3A/);
    const planted = cookie.replace(/^__Host-/, '');
    expect((await root.ask('GET', '/api/me', planted)).status).toBe(401);
    expect((await root.ask('GET', '/api/me', cookie)).body).toEqual({ id: 'u1' });
  });

  it('signs out of both names, the secure one with the flag a browser needs to drop it', async () => {
    const root = await signedIn('https://app.example.com');
    const cookie = await root.signIn('u1');
    const out = await root.ask('POST', '/out', cookie);
    expect(out.set.map((line) => [line.split('=')[0], /;\s*Secure/i.test(line)])).toEqual([['__Host-koala_sid', true], ['koala_sid', false]]);
    expect((await root.ask('GET', '/api/me', cookie)).status).toBe(401);
  });
});
