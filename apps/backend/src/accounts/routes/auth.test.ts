import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { authRouter } from './auth.js';
import { passwordRouter } from './password.js';
import { devicesFor } from './device.js';
import { createAuth } from '../../platform/middleware/auth.js';
import { SessionEnds } from '../../platform/services/SessionEnds.js';
import { PasswordService } from '../services/PasswordService.js';
import { breachedFrom } from '../lib/passwords.js';
import type { CodeMail } from '../services/AuthService.js';
import type { AccessRevoked } from '../../platform/lib/revocations.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { AuthService } from '../services/AuthService.js';
import { inviteCodeHash } from '../../platform/lib/invite-codes.js';
import { deviceToken, hashPassword, sessionToken } from '../../platform/lib/auth.js';

const JWT_SECRET = 'test-secret';
const SETUP_CODE = 'the-setup-code';

async function serve(db: Database, options: { mail?: CodeMail; production?: boolean } = {}) {
  const revoked: AccessRevoked[] = [];
  const revocations = { revoked: async (event: AccessRevoked) => { revoked.push(event); } };
  const auth = createAuth({ db, sessionKey: JWT_SECRET, publicUrl: 'http://localhost:3001', setupCode: SETUP_CODE, sessionEnds: new SessionEnds(db.platform) });
  const authService = new AuthService(db, { ...options, revocations });
  const passwords = new PasswordService({ db, auth: authService, breached: breachedFrom('password1234\n'), revocations });
  const devices = devicesFor({ auth, sessionKey: JWT_SECRET, authService });
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
    revocations,
    passwords,
  }));
  app.use('/api/auth/password', passwordRouter({ passwords, auth, devices, sessionKey: JWT_SECRET }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { server, authService, revoked, url: (p: string) => `http://127.0.0.1:${port}${p}` };
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
      body: JSON.stringify({ email, password, inviteCode: SETUP_CODE }),
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

  it('lets a browser that signed in before through while the account is locked to everyone else, and keeps locking a guesser on their own browser', async () => {
    const { login } = await registerAndLogin('known@example.com', 'hunter2hunter2');
    const device = login.headers.getSetCookie().map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('device='))!;
    expect(device).toBeDefined();
    const attempt = (password: string, cookie?: string) => fetch(ctx.url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ email: 'known@example.com', password }) });
    for (let n = 0; n < 10; n += 1) expect((await attempt('wrong')).status).toBe(401);
    expect((await attempt('hunter2hunter2')).status).toBe(429);
    const known = await attempt('hunter2hunter2', device);
    expect(known.status).toBe(200);
    expect(known.headers.getSetCookie().find((line) => line.startsWith('device='))!.split(';')[0]).toBeDefined();
    expect((await attempt('hunter2hunter2', `device=${deviceToken('other@example.com', JWT_SECRET)}`)).status).toBe(429);
    expect((await attempt('hunter2hunter2', `device=${deviceToken('known@example.com', 'another-key')}`)).status).toBe(429);
    for (let n = 0; n < 10; n += 1) expect((await attempt('wrong', device)).status).toBe(401);
    expect((await attempt('hunter2hunter2', device)).status).toBe(429);
  });

  it('registers, logs in and returns the caller from the minted cookie', async () => {
    const { login, session } = await registerAndLogin('first@example.com', 'hunter2hunter2');
    expect(login.status).toBe(200);
    expect(session).toMatch(/^session=/);

    const me = await fetch(ctx.url('/api/auth/me'), { headers: { cookie: session } });
    expect(me.status).toBe(200);
    expect((await me.json() as { email: string }).email).toBe('first@example.com');
  });

  it('tells the first account what the operator may do, from authorize, and a later one only what a person may', async () => {
    const { login, session } = await registerAndLogin('first@example.com', 'hunter2hunter2');
    const signedIn = (await login.json() as { user: { claims: unknown; permissions: Record<string, boolean>; isAdmin?: unknown } }).user;
    const me = await (await fetch(ctx.url('/api/auth/me'), { headers: { cookie: session } })).json() as { claims: unknown; permissions: Record<string, boolean>; isAdmin?: unknown; holdsAccounts?: unknown };
    expect(me.claims).toEqual([{ role: 'person' }, { role: 'operator' }]);
    expect(me.permissions).toEqual({
      administer: true, 'manage-accounts': true, 'see-all-work': true, 'open-platform-namespaces': true, 'change-instance-settings': false, 'manage-own-account': true,
    });
    expect(signedIn.permissions).toEqual(me.permissions);
    expect('isAdmin' in me || 'holdsAccounts' in me || 'isAdmin' in signedIn).toBe(false);

    await db.accounts.saveUser({ id: 'plain', email: 'plain@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: '2026-01-01' });
    const plain = await fetch(ctx.url('/api/auth/me'), { headers: { cookie: `session=${sessionToken({ id: 'plain', email: 'plain@example.com' }, JWT_SECRET)}` } });
    expect((await plain.json() as { permissions: Record<string, boolean> }).permissions).toEqual({
      administer: false, 'manage-accounts': false, 'see-all-work': false, 'open-platform-namespaces': false, 'change-instance-settings': false, 'manage-own-account': true,
    });
  });

  it('makes only a sign-up with the setup code the first account, and only one of two at once', async () => {
    const signUp = (email: string, inviteCode?: string) => fetch(ctx.url('/api/auth/register'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'hunter2hunter2', ...(inviteCode ? { inviteCode } : {}) }),
    });
    const stranger = await signUp('stranger@example.com');
    expect(stranger.status).toBe(403);
    expect(((await stranger.json()) as { error: string }).error).toBe('This Koala has no account yet: the first sign-up needs its setup code, which its installer printed');
    expect((await signUp('guess@example.com', 'the-setup-cod')).status).toBe(403);
    const both = await Promise.all([signUp('a@example.com', SETUP_CODE), signUp('b@example.com', SETUP_CODE)]);
    expect(both.map((response) => response.status).sort()).toEqual([200, 403]);
    expect((await db.accounts.getUsers()).filter((user) => user.roles?.includes('operator'))).toHaveLength(1);
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
    expect(first?.roles).toEqual(['operator']);
  });

  const post = (path: string, body: unknown, cookie?: string) => fetch(ctx.url(path), {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  const signUpWith = async (email: string, inviteCode: string) => {
    const answer = await post('/api/auth/register', { email, password: 'hunter2hunter2', inviteCode });
    return { status: answer.status, body: await answer.json() as { verify?: string; devCode?: string; error?: string } };
  };

  it('keeps a sign-up pending until the emailed code is entered, spending the invite and signing in only then', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.accounts.saveInvite({ id: 'inv-code', codeHash: inviteCodeHash('CODE'), createdBy: 'first', createdAt: new Date().toISOString() });
    const started = await signUpWith('Pending@Example.com', 'CODE');
    expect(started.status).toBe(200);
    expect(started.body.verify).toEqual(expect.any(String));
    expect(started.body.devCode).toMatch(/^\d{6}$/);
    expect(await db.accounts.getUserByEmail('pending@example.com')).toBeUndefined();
    expect((await db.accounts.getInviteByCode('CODE'))?.usedBy).toBeUndefined();
    const pending = await db.accounts.getPendingSignUp(started.body.verify!);
    expect(JSON.stringify(pending)).not.toContain(started.body.devCode);
    expect(JSON.stringify(pending)).not.toContain('"CODE"');

    const done = await post('/api/auth/register/verify', { id: started.body.verify, code: started.body.devCode });
    expect(done.status).toBe(200);
    const session = done.headers.getSetCookie().map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('session='))!;
    expect(done.headers.getSetCookie().some((line) => line.startsWith('device='))).toBe(true);
    expect((await (await fetch(ctx.url('/api/auth/me'), { headers: { cookie: session } })).json() as { email: string }).email).toBe('pending@example.com');
    const user = await db.accounts.getUserByEmail('pending@example.com');
    expect(user?.emailVerified).toBe(true);
    expect(user?.roles).toBeUndefined();
    expect((await db.accounts.getInviteByCode('CODE'))?.usedBy).toBe(user?.id);
    expect(await db.accounts.getPendingSignUp(started.body.verify!)).toBeUndefined();
    expect((await post('/api/auth/register/verify', { id: started.body.verify, code: started.body.devCode })).status).toBe(410);
  });

  it('ends a sign-up after five wrong codes, and refuses an expired one', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.accounts.saveInvite({ id: 'inv-guess', codeHash: inviteCodeHash('GUESS'), createdBy: 'first', createdAt: new Date().toISOString() });
    const started = await signUpWith('guess@example.com', 'GUESS');
    const wrong = started.body.devCode === '000000' ? '111111' : '000000';
    expect((await post('/api/auth/register/verify', { id: started.body.verify, code: 'abc' })).status).toBe(400);
    for (let n = 0; n < 4; n += 1) expect((await post('/api/auth/register/verify', { id: started.body.verify, code: wrong })).status).toBe(401);
    expect((await post('/api/auth/register/verify', { id: started.body.verify, code: wrong })).status).toBe(410);
    expect((await post('/api/auth/register/verify', { id: started.body.verify, code: started.body.devCode })).status).toBe(410);
    expect(await db.accounts.getUserByEmail('guess@example.com')).toBeUndefined();

    const late = await signUpWith('late@example.com', 'GUESS');
    const pending = (await db.accounts.getPendingSignUp(late.body.verify!))!;
    await db.accounts.savePendingSignUp({ ...pending, expiresAt: new Date(Date.now() - 1000) });
    expect((await post('/api/auth/register/verify', { id: late.body.verify, code: late.body.devCode })).status).toBe(410);
  });

  it('sends a new code that replaces the last, a few times at most', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.accounts.saveInvite({ id: 'inv-again', codeHash: inviteCodeHash('AGAIN'), createdBy: 'first', createdAt: new Date().toISOString() });
    const started = await signUpWith('again@example.com', 'AGAIN');
    const resent = await (await post('/api/auth/register/resend', { id: started.body.verify })).json() as { verify: string; devCode: string };
    expect(resent.verify).toBe(started.body.verify);
    if (resent.devCode !== started.body.devCode) expect((await post('/api/auth/register/verify', { id: started.body.verify, code: started.body.devCode })).status).toBe(401);
    for (let n = 0; n < 3; n += 1) expect((await post('/api/auth/register/resend', { id: started.body.verify })).status).toBe(200);
    expect((await post('/api/auth/register/resend', { id: started.body.verify })).status).toBe(429);
    expect((await post('/api/auth/register/resend', { id: 'no-such-sign-up' })).status).toBe(410);
  });

  it('refuses a malformed email, and an email taken while the sign-up waited', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.accounts.saveInvite({ id: 'inv-taken', codeHash: inviteCodeHash('TAKEN'), createdBy: 'first', createdAt: new Date().toISOString() });
    for (const email of ['no-at-sign', 'two@@example.com', 'a@nodot', 'sp ace@example.com', 'a@example..com', `${'a'.repeat(250)}@example.com`]) {
      const refused = await signUpWith(email, 'TAKEN');
      expect(refused.status, email).toBe(400);
      expect(refused.body.error).toBe('That is not an email address; check it and try again');
    }
    const started = await signUpWith('taken@example.com', 'TAKEN');
    await db.accounts.saveUser({ id: 'u-taken', email: 'taken@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString() });
    const done = await post('/api/auth/register/verify', { id: started.body.verify, code: started.body.devCode });
    expect(done.status).toBe(410);
    expect((await db.accounts.getInviteByCode('TAKEN'))?.usedBy).toBeUndefined();
  });

  it('keeps the first admin signing up at once with the setup code, its address not yet confirmed', async () => {
    const first = await post('/api/auth/register', { email: 'owner@example.com', password: 'hunter2hunter2', inviteCode: SETUP_CODE });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { verify?: string }).verify).toBeUndefined();
    const owner = await db.accounts.getUserByEmail('owner@example.com');
    expect(owner?.roles).toEqual(['operator']);
    expect(owner?.emailVerified).toBe(false);
  });

  it('consumes an invite exactly once', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.accounts.saveInvite({ id: 'inv-letmein', codeHash: inviteCodeHash('LETMEIN'), createdBy: 'first', createdAt: new Date().toISOString() });

    const ok = await signUpWith('second@example.com', 'LETMEIN');
    expect(ok.status).toBe(200);
    expect((await post('/api/auth/register/verify', { id: ok.body.verify, code: ok.body.devCode })).status).toBe(200);
    expect((await db.accounts.getUserByEmail('second@example.com'))?.roles).toBeUndefined();

    const reuse = await fetch(ctx.url('/api/auth/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'third@example.com', password: 'hunter2hunter2', inviteCode: 'LETMEIN' }),
    });
    expect(reuse.status).toBe(403);
    expect((await reuse.json() as { error: string }).error).toMatch(/already been used/i);
  });

  it('refuses an invite past its two weeks', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.accounts.saveInvite({ id: 'inv-old', codeHash: inviteCodeHash('OLD'), createdBy: 'first', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-15T00:00:00.000Z' });
    const late = await fetch(ctx.url('/api/auth/register'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'late@example.com', password: 'hunter2hunter2', inviteCode: 'OLD' }) });
    expect(late.status).toBe(403);
    expect(((await late.json()) as { error: string }).error).toBe('This invite has expired; ask whoever sent it for a new one');
  });

  it('lets only one of two sign-ups at the same moment use an invite', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.accounts.saveInvite({ id: 'inv-once', codeHash: inviteCodeHash('ONCE'), createdBy: 'first', createdAt: new Date().toISOString() });
    const started = await Promise.all(['a@example.com', 'b@example.com', 'c@example.com'].map((email) => signUpWith(email, 'ONCE')));
    expect(started.map((answer) => answer.status)).toEqual([200, 200, 200]);
    const done = await Promise.all(started.map((answer) => post('/api/auth/register/verify', { id: answer.body.verify, code: answer.body.devCode })));
    expect(done.map((response) => response.status).sort()).toEqual([200, 403, 403]);
    expect((await db.accounts.getUsers()).filter((user) => !user.roles?.includes('operator'))).toHaveLength(1);
  });

  it('asks for a code against a signed challenge, counts wrong codes per account across sign-ins, and never takes the challenge as a session', async () => {
    const { session } = await registerAndLogin('two@example.com', 'hunter2hunter2');
    const codes: string[] = [];
    vi.spyOn(ctx.authService, 'send2FACode').mockImplementation(async (_user, code) => { codes.push(code); });
    expect((await post('/api/auth/2fa/settings', { enabled: true, preferredMethod: 'email' }, session)).status).toBe(403);
    const on = await post('/api/auth/2fa/settings', { enabled: true, preferredMethod: 'email', password: 'hunter2hunter2' }, session);
    expect(on.status).toBe(200);
    const signIn = async () => {
      const answer = await post('/api/auth/login', { email: 'two@example.com', password: 'hunter2hunter2' });
      return { status: answer.status, ...(await answer.json() as { twoFactorRequired: boolean; challenge: string; userId?: string; error?: string }), code: codes.at(-1)! };
    };
    const verify = (challenge: string, code: string) => post('/api/auth/2fa/verify', { challenge, code });
    const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000');

    const first = await signIn();
    expect(first.twoFactorRequired).toBe(true);
    expect(first.userId).toBeUndefined();
    expect((await fetch(ctx.url('/api/auth/me'), { headers: { cookie: `session=${first.challenge}` } })).status).toBe(401);
    expect((await verify('not-a-challenge', first.code)).status).toBe(400);
    for (let n = 0; n < 3; n += 1) expect((await verify(first.challenge, wrongFor(first.code))).status).toBe(400);
    const second = await signIn();
    expect((await verify(second.challenge, wrongFor(second.code))).status).toBe(400);
    const locked = await verify(second.challenge, wrongFor(second.code));
    expect(locked.status).toBe(429);
    expect((await verify(second.challenge, second.code)).status).toBe(429);
    const third = await signIn();
    expect(third.status).toBe(429);
    expect(third.error).toMatch(/wrong codes/);
    expect(codes).toHaveLength(2);
  });

  it('lets the right code through after a wrong one, without the challenge being taken as a session', async () => {
    const { session } = await registerAndLogin('right@example.com', 'hunter2hunter2');
    const codes: string[] = [];
    vi.spyOn(ctx.authService, 'send2FACode').mockImplementation(async (_user, code) => { codes.push(code); });
    await post('/api/auth/2fa/settings', { enabled: true, preferredMethod: 'email', password: 'hunter2hunter2' }, session);
    const answer = await (await post('/api/auth/login', { email: 'right@example.com', password: 'hunter2hunter2' })).json() as { challenge: string };
    expect((await post('/api/auth/2fa/verify', { challenge: answer.challenge, code: codes[0] === '000000' ? '111111' : '000000' })).status).toBe(400);
    const passed = await post('/api/auth/2fa/verify', { challenge: answer.challenge, code: codes[0] });
    expect(passed.status).toBe(200);
    expect(passed.headers.get('set-cookie')).toMatch(/^session=/);
  });

  it('ends every other session on request and when two-factor settings change, keeping the one that asked', async () => {
    await registerAndLogin('many@example.com', 'hunter2hunter2');
    const signIn = async () => ((await fetch(ctx.url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'many@example.com', password: 'hunter2hunter2' }) })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const me = async (cookie: string) => (await fetch(ctx.url('/api/auth/me'), { headers: { cookie } })).status;
    const laptop = await signIn();
    const phone = await signIn();

    const ended = await fetch(ctx.url('/api/auth/sessions/end-others'), { method: 'POST', headers: { cookie: laptop } });
    const kept = (ended.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect([await me(phone), await me(laptop), await me(kept)]).toEqual([401, 401, 200]);

    const tablet = await signIn();
    const changed = await fetch(ctx.url('/api/auth/2fa/settings'), { method: 'POST', headers: { 'content-type': 'application/json', cookie: kept }, body: JSON.stringify({ enabled: false, password: 'hunter2hunter2' }) });
    const after = (changed.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect([await me(tablet), await me(after)]).toEqual([401, 200]);
  });

  it('normalises the email on registration so login can find it again', async () => {
    await fetch(ctx.url('/api/auth/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: '  MixedCase@Example.COM ', password: 'hunter2hunter2', inviteCode: SETUP_CODE }),
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
    const cleared = out.headers.getSetCookie();
    expect(cleared.map((cookie) => cookie.split('=')[0])).toEqual(['__Host-session', 'session']);
    for (const cookie of cleared) {
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    }
    expect(cleared[0]).toMatch(/Secure/);
    expect((await fetch(ctx.url('/api/auth/me'), { headers: { cookie: session } })).status).toBe(401);
    expect(await db.platform.sessionsEndedSince(0)).toHaveLength(1);
  });

  it('rejects a session signed with the wrong secret', async () => {
    const { session } = await registerAndLogin('first@example.com', 'hunter2hunter2');
    const forged = session.replace(/\.[^.]+$/, '.not-the-right-signature');
    const me = await fetch(ctx.url('/api/auth/me'), { headers: { cookie: forged } });
    expect(me.status).toBe(401);
  });

  it('refuses a new password shorter than twelve characters or on the leaked list, before anything is made', async () => {
    const short = await post('/api/auth/register', { email: 'short@example.com', password: 'hunter2', inviteCode: SETUP_CODE });
    expect(short.status).toBe(400);
    expect(((await short.json()) as { error: string }).error).toBe('Use at least 12 characters for your password');
    const leaked = await post('/api/auth/register', { email: 'leaked@example.com', password: 'Password1234', inviteCode: SETUP_CODE });
    expect(((await leaked.json()) as { error: string }).error).toContain('leaked');
    expect(await db.accounts.getUsers()).toHaveLength(0);
  });

  it('keeps a password set before the rules working', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    const user = (await db.accounts.getUserByEmail('first@example.com'))!;
    await db.accounts.saveUser({ ...user, passwordHash: await hashPassword('short') });
    expect((await post('/api/auth/login', { email: 'first@example.com', password: 'short' })).status).toBe(200);
  });

  it('answers a sign-up with an address that has an account as it answers a new one, and never lets it through', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.accounts.saveInvite({ id: 'inv-dup', codeHash: inviteCodeHash('DUP'), createdBy: 'first', createdAt: new Date().toISOString() });
    const taken = await signUpWith('First@example.com', 'DUP');
    expect(taken.status).toBe(200);
    expect(taken.body.verify).toEqual(expect.any(String));
    for (let n = 0; n < 4; n += 1) expect((await post('/api/auth/register/verify', { id: taken.body.verify, code: String(100000 + n) })).status).toBe(401);
    expect((await post('/api/auth/register/verify', { id: taken.body.verify, code: '100004' })).status).toBe(410);
    expect((await db.accounts.getInviteByCode('DUP'))?.usedBy).toBeUndefined();
    expect(await db.accounts.getUsers()).toHaveLength(1);
  });

  it('in production, emails a taken address its owner instead of a code, answering exactly as for a new address', async () => {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const mail = { available: () => ({ ok: true as const }), toAddress: async (to: string, message: { subject: string; text: string }) => { sent.push({ to, ...message }); } };
    await new Promise<void>((r) => ctx.server.close(() => r()));
    ctx = await serve(db, { mail, production: true });
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    await db.accounts.saveInvite({ id: 'inv-p', codeHash: inviteCodeHash('PROD'), createdBy: 'first', createdAt: new Date().toISOString() });
    const taken = await signUpWith('first@example.com', 'PROD');
    const fresh = await signUpWith('fresh@example.com', 'PROD');
    expect(Object.keys(taken.body)).toEqual(['verify']);
    expect(Object.keys(fresh.body)).toEqual(['verify']);
    expect(sent.map((message) => [message.to, message.subject])).toEqual([['first@example.com', 'You already have a Koala account'], ['fresh@example.com', 'Your Koala sign-up code']]);
    expect(sent[0]!.text).not.toMatch(/\b\d{6}\b/);
  });

  it('resets a forgotten password by an emailed code, ending every session of the account and telling every place it is signed in', async () => {
    const { session } = await registerAndLogin('forgot@example.com', 'hunter2hunter2');
    const asked = await (await post('/api/auth/password/forgot', { email: ' Forgot@Example.com ' })).json() as { reset: string; devCode: string };
    expect(asked.devCode).toMatch(/^\d{6}$/);
    expect(JSON.stringify(await db.accounts.getPasswordReset(asked.reset))).not.toContain(asked.devCode);
    const wrong = asked.devCode === '000000' ? '111111' : '000000';
    expect((await post('/api/auth/password/reset', { id: asked.reset, code: asked.devCode, password: 'short' })).status).toBe(400);
    expect((await post('/api/auth/password/reset', { id: asked.reset, code: wrong, password: 'a-brand-new-password' })).status).toBe(401);
    const done = await post('/api/auth/password/reset', { id: asked.reset, code: asked.devCode, password: 'a-brand-new-password' });
    expect(done.status).toBe(200);
    expect(done.headers.getSetCookie()).toEqual([]);
    expect((await fetch(ctx.url('/api/auth/me'), { headers: { cookie: session } })).status).toBe(401);
    expect((await post('/api/auth/password/reset', { id: asked.reset, code: asked.devCode, password: 'another-new-password' })).status).toBe(410);
    expect((await post('/api/auth/login', { email: 'forgot@example.com', password: 'hunter2hunter2' })).status).toBe(401);
    expect((await post('/api/auth/login', { email: 'forgot@example.com', password: 'a-brand-new-password' })).status).toBe(200);
    expect(ctx.revoked).toEqual([expect.objectContaining({ because: 'password-or-2fa', personId: (await db.accounts.getUserByEmail('forgot@example.com'))!.id })]);
  });

  it('ends a reset after five wrong codes, sends a new code a few times at most, and answers for an address with no account as for one with', async () => {
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    const nobody = await post('/api/auth/password/forgot', { email: 'nobody@example.com' });
    expect(nobody.status).toBe(200);
    const unknown = await nobody.json() as { reset: string; devCode?: string };
    expect(unknown.devCode).toBeUndefined();
    for (let n = 0; n < 4; n += 1) expect((await post('/api/auth/password/reset', { id: unknown.reset, code: String(200000 + n), password: 'a-brand-new-password' })).status).toBe(401);
    expect((await post('/api/auth/password/reset', { id: unknown.reset, code: '200004', password: 'a-brand-new-password' })).status).toBe(410);
    const asked = await (await post('/api/auth/password/forgot', { email: 'first@example.com' })).json() as { reset: string };
    for (let n = 0; n < 4; n += 1) expect((await post('/api/auth/password/forgot/resend', { id: asked.reset })).status).toBe(200);
    expect((await post('/api/auth/password/forgot/resend', { id: asked.reset })).status).toBe(429);
    expect((await post('/api/auth/password/forgot', { email: 'not an address' })).status).toBe(400);
  });

  it('in production, emails the reset code only to an account that exists and hands no code back, and refuses where no email can be sent', async () => {
    const sent: Array<{ to: string; text: string }> = [];
    const mail = { available: () => ({ ok: true as const }), toAddress: async (to: string, message: { text: string }) => { sent.push({ to, text: message.text }); } };
    await new Promise<void>((r) => ctx.server.close(() => r()));
    ctx = await serve(db, { mail, production: true });
    await registerAndLogin('first@example.com', 'hunter2hunter2');
    const known = await (await post('/api/auth/password/forgot', { email: 'first@example.com' })).json() as Record<string, unknown>;
    const unknown = await (await post('/api/auth/password/forgot', { email: 'nobody@example.com' })).json() as Record<string, unknown>;
    expect(Object.keys(known)).toEqual(['reset']);
    expect(Object.keys(unknown)).toEqual(['reset']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent.map((message) => message.to)).toEqual(['first@example.com']);
    const code = /\b(\d{6})\b/.exec(sent[0]!.text)![1];
    expect((await post('/api/auth/password/reset', { id: known.reset, code, password: 'a-brand-new-password' })).status).toBe(200);

    await new Promise<void>((r) => ctx.server.close(() => r()));
    ctx = await serve(db, { mail: { available: () => ({ ok: false as const, why: 'MAIL_SMTP_URL is not set' }), toAddress: async () => undefined }, production: true });
    const refused = await post('/api/auth/password/forgot', { email: 'first@example.com' });
    expect(refused.status).toBe(503);
  });

  it('changes a password only with the current one, and a code too with two-factor on, ending every other session', async () => {
    const { session } = await registerAndLogin('change@example.com', 'hunter2hunter2');
    const other = ((await post('/api/auth/login', { email: 'change@example.com', password: 'hunter2hunter2' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await post('/api/auth/password', { password: 'a-brand-new-password' }, session)).status).toBe(403);
    expect((await post('/api/auth/password', { password: 'a-brand-new-password', current: 'not-my-password' }, session)).status).toBe(403);
    expect((await post('/api/auth/password', { password: 'password1234', current: 'hunter2hunter2' }, session)).status).toBe(400);
    expect((await post('/api/auth/password', { password: 'a-brand-new-password' })).status).toBe(401);
    const changed = await post('/api/auth/password', { password: 'a-brand-new-password', current: 'hunter2hunter2' }, session);
    expect(changed.status).toBe(200);
    const kept = (changed.headers.get('set-cookie') ?? '').split(';')[0]!;
    const me = async (cookie: string) => (await fetch(ctx.url('/api/auth/me'), { headers: { cookie } })).status;
    expect([await me(other), await me(session), await me(kept)]).toEqual([401, 401, 200]);

    const codes: string[] = [];
    vi.spyOn(ctx.authService, 'send2FACode').mockImplementation(async (_user, code) => { codes.push(code); });
    const on = await post('/api/auth/2fa/settings', { enabled: true, preferredMethod: 'email', password: 'a-brand-new-password' }, kept);
    const twoFactor = (on.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await post('/api/auth/password', { password: 'yet-another-password', current: 'a-brand-new-password' }, twoFactor)).status).toBe(403);
    expect((await post('/api/auth/confirm/code', {}, twoFactor)).status).toBe(200);
    const again = await post('/api/auth/password', { password: 'yet-another-password', current: 'a-brand-new-password', code: codes.at(-1) }, twoFactor);
    expect(again.status).toBe(200);
  });

  it('sends a confirmation code only to an account that confirms with one, and asks it before two-factor goes off', async () => {
    const { session } = await registerAndLogin('confirm@example.com', 'hunter2hunter2');
    expect((await post('/api/auth/confirm/code', {}, session)).status).toBe(400);
    const codes: string[] = [];
    vi.spyOn(ctx.authService, 'send2FACode').mockImplementation(async (_user, code) => { codes.push(code); });
    const on = await post('/api/auth/2fa/settings', { enabled: true, preferredMethod: 'email', password: 'hunter2hunter2' }, session);
    const cookie = (on.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(((await (await fetch(ctx.url('/api/auth/me'), { headers: { cookie } })).json()) as { confirmWith: string }).confirmWith).toBe('two-factor');
    expect((await post('/api/auth/2fa/settings', { enabled: false, password: 'hunter2hunter2' }, cookie)).status).toBe(403);
    await post('/api/auth/confirm/code', {}, cookie);
    const off = await post('/api/auth/2fa/settings', { enabled: false, code: codes.at(-1) }, cookie);
    expect(off.status).toBe(200);
    expect((await db.accounts.getUserByEmail('confirm@example.com'))?.twoFactorEnabled).toBe(false);
  });
});
