import { randomBytes } from 'node:crypto';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { startThreeRoles, until, type ThreeRoles } from '../platform/testing/three-roles.js';
import { textOf, type Received, type SmtpSink } from '../platform/testing/smtp-sink.js';
import type { LoopbackRole } from '../platform/testing/roles-on-loopback.js';

interface Answer { status: number; cookie: string | undefined; body: unknown }

async function call(url: string, init: { method?: string; body?: unknown; cookie?: string | undefined } = {}): Promise<Answer> {
  const response = await fetch(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    redirect: 'manual',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.cookie ? { Cookie: init.cookie } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const cookie = response.headers.getSetCookie().map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?session=/.test(pair));
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text) as unknown; } catch { body = text; }
  return { status: response.status, cookie, body };
}

const SUBJECTS = {
  signUp: 'Your Koala sign-up code',
  reset: 'Your Koala password reset code',
  signIn: 'Your Koala sign-in code',
  confirm: 'Your Koala confirmation code',
  lock: 'Your Koala account is locked to other browsers',
} as const;

interface Opened { socket: Socket; closed: Promise<string> }

const sockets: Socket[] = [];

const opened = (base: string, cookie: string | undefined): Promise<Opened> => new Promise((resolve, reject) => {
  const socket = connect(base, { transports: ['websocket'], extraHeaders: { cookie: cookie ?? '' }, reconnection: false, forceNew: true });
  sockets.push(socket);
  const closed = new Promise<string>((done) => socket.on('disconnect', (reason) => done(reason)));
  socket.on('connect', () => resolve({ socket, closed }));
  socket.on('connect_error', (err) => reject(err));
});

const STAMP = Date.now().toString(36);
let roles: ThreeRoles;
let root: LoopbackRole;
let instance: LoopbackRole;
let mail: SmtpSink;
let owner: ThreeRoles['owner'];

const rootCall = (path: string, init: { method?: string; body?: unknown; cookie?: string | undefined } = {}) => call(`${root.url}${path}`, init);
const me = async (cookie: string | undefined) => (await rootCall('/api/auth/me', { cookie })).status;
const to = (message: Received, email: string) => message.to.some((address) => address.toLowerCase() === email.toLowerCase());
const mailsTo = (email: string, subject: string, from = 0) => mail.received.slice(from).filter((message) => to(message, email) && mail.subjectOf(message) === subject);
const mailed = async (email: string, subject: string, from: number): Promise<string> => until(async () => {
  for (const message of mailsTo(email, subject, from)) {
    const code = /\b(\d{6})\b/.exec(textOf(message))?.[1];
    if (code) return code;
  }
  return undefined;
});
const invite = async () => {
  const minted = await rootCall('/api/admin/invites', { body: {}, cookie: owner.cookie });
  expect([200, 201], JSON.stringify(minted.body)).toContain(minted.status);
  return (minted.body as { code: string }).code;
};
const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000');
const fresh = (who: string) => `${who}-${randomBytes(12).toString('base64url')}`;

const patEmail = `pat-${STAMP}@hardening.test`;
let patPassword = fresh('pat');
let patCookie: string | undefined;
let forOwner: Answer;
let ownerResetCode = '';
let keptOnInstance = '';
let keptSocket: Opened;
let signedOutCookie: string | undefined;
let stillSignedIn: string | undefined;

beforeAll(async () => {
  roles = await startThreeRoles('hardening');
  ({ root, instance, mail, owner } = roles);
}, 240_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await roles?.close();
});

describe('an account is hard to take over, on a root of its own beside an instance and a hub', () => {
  it('refuses a short or leaked password, and hands no sign-up code back: the code only goes by email', async () => {
    const patInvite = await invite();
    for (const [password, said] of [['short-pw', /at least 12 characters/], ['Password1234', /leaked/]] as const) {
      const refused = await rootCall('/api/auth/register', { body: { email: patEmail, password, inviteCode: patInvite } });
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect((refused.body as { error: string }).error).toMatch(said);
    }
    const from = mail.received.length;
    const registered = await rootCall('/api/auth/register', { body: { email: patEmail, password: patPassword, inviteCode: patInvite } });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    expect(Object.keys(registered.body as object)).toEqual(['verify']);
    const verified = await rootCall('/api/auth/register/verify', { body: { id: (registered.body as { verify: string }).verify, code: await mailed(patEmail, SUBJECTS.signUp, from) } });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    patCookie = verified.cookie;
    expect(patCookie).toBeTruthy();
    const quinnEmail = `quinn-${STAMP}@hardening.test`;
    const quinnFrom = mail.received.length;
    const quinn = await rootCall('/api/auth/register', { body: { email: quinnEmail, password: fresh('quinn'), inviteCode: await invite() } });
    expect(quinn.status, JSON.stringify(quinn.body)).toBe(200);
    expect(Object.keys(quinn.body as object)).toEqual(['verify']);
    const quinnVerified = await rootCall('/api/auth/register/verify', { body: { id: (quinn.body as { verify: string }).verify, code: await mailed(quinnEmail, SUBJECTS.signUp, quinnFrom) } });
    expect(quinnVerified.status, JSON.stringify(quinnVerified.body)).toBe(200);
    expect(quinnVerified.cookie).toBeTruthy();
  });

  it('asked to reset a password, answers alike whether or not the account exists, hands no code back, and mails only an account that does', async () => {
    const from = mail.received.length;
    const nobody = `nobody-${STAMP}@hardening.test`;
    forOwner = await rootCall('/api/auth/password/forgot', { body: { email: owner.email } });
    const forNobody = await rootCall('/api/auth/password/forgot', { body: { email: nobody } });
    expect(forOwner.status, JSON.stringify(forOwner.body)).toBe(200);
    expect(forNobody.status, JSON.stringify(forNobody.body)).toBe(200);
    expect(Object.keys(forOwner.body as object)).toEqual(['reset']);
    expect(Object.keys(forNobody.body as object)).toEqual(['reset']);
    ownerResetCode = await mailed(owner.email, SUBJECTS.reset, from);
    expect(mail.received.slice(from).filter((message) => to(message, nobody))).toEqual([]);
  });

  it('signing out on the instance ends that session there, whoever holds its cookie, and closes the connection made with it', async () => {
    const leftOnInstance = await roles.ownerOnInstance();
    expect((await call(`${instance.url}/api/auth/me`, { cookie: leftOnInstance })).status).toBe(200);
    const leftSocket = await opened(instance.url, leftOnInstance);
    const signedOut = await call(`${instance.url}/api/auth/logout`, { body: {}, cookie: leftOnInstance });
    expect(signedOut.status, JSON.stringify(signedOut.body)).toBe(200);
    expect((await call(`${instance.url}/api/auth/me`, { cookie: leftOnInstance })).status).toBe(401);
    expect(await leftSocket.closed).toBe('io server disconnect');
    await expect(opened(instance.url, leftOnInstance)).rejects.toThrow(/Unauthorized/);
    keptOnInstance = await roles.ownerOnInstance();
    expect((await call(`${instance.url}/api/auth/me`, { cookie: keptOnInstance })).status).toBe(200);
    keptSocket = await opened(instance.url, keptOnInstance);
  });

  it('the emailed code resets the owner\'s password: every session ends, root\'s and the instance\'s, and only the new password signs in', async () => {
    const resetId = (forOwner.body as { reset: string }).reset;
    expect((await rootCall('/api/auth/password/reset', { body: { id: resetId, code: wrongFor(ownerResetCode), password: 'a-new-owner-password' } })).status).toBe(401);
    expect((await rootCall('/api/auth/password/reset', { body: { id: resetId, code: ownerResetCode, password: 'password1234' } })).status).toBe(400);
    const ownerPassword = fresh('owner');
    const reset = await rootCall('/api/auth/password/reset', { body: { id: resetId, code: ownerResetCode, password: ownerPassword } });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(await me(owner.cookie)).toBe(401);
    await until(async () => ((await call(`${instance.url}/api/auth/me`, { cookie: keptOnInstance })).status === 401 ? true : undefined));
    expect(await keptSocket.closed).toBe('io server disconnect');
    const ownerAgain = await rootCall('/api/auth/login', { body: { email: owner.email, password: ownerPassword } });
    expect(ownerAgain.status, JSON.stringify(ownerAgain.body)).toBe(200);
    owner.cookie = ownerAgain.cookie!;
  });

  it('changing a password asks for the current one, and ends every other session', async () => {
    const elsewhere = (await rootCall('/api/auth/login', { body: { email: patEmail, password: patPassword } })).cookie;
    expect(await me(elsewhere)).toBe(200);
    const nextPassword = fresh('pat');
    expect((await rootCall('/api/auth/password', { body: { password: nextPassword }, cookie: patCookie })).status).toBe(403);
    expect((await rootCall('/api/auth/password', { body: { password: nextPassword, current: 'not-the-password' }, cookie: patCookie })).status).toBe(403);
    const changed = await rootCall('/api/auth/password', { body: { password: nextPassword, current: patPassword }, cookie: patCookie });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect([await me(elsewhere), await me(patCookie), await me(changed.cookie)]).toEqual([401, 401, 200]);
    patPassword = nextPassword;
    patCookie = changed.cookie;
  });

  it('two-factor goes on only with the password, and then a risky change is refused without a current code', async () => {
    expect((await rootCall('/api/auth/2fa/settings', { body: { enabled: true, preferredMethod: 'email' }, cookie: patCookie })).status).toBe(403);
    const on = await rootCall('/api/auth/2fa/settings', { body: { enabled: true, preferredMethod: 'email', password: patPassword }, cookie: patCookie });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    patCookie = on.cookie;
    expect(((await rootCall('/api/auth/me', { cookie: patCookie })).body as { confirmWith: string }).confirmWith).toBe('two-factor');
    for (const [path, method, body] of [
      ['/api/auth/2fa/settings', 'POST', { enabled: false, password: patPassword }],
      ['/api/account', 'DELETE', { confirm: patEmail, password: patPassword }],
      ['/api/auth/password', 'POST', { password: fresh('pat'), current: patPassword }],
    ] as const) {
      const refused = await rootCall(path, { method, body, cookie: patCookie });
      expect(refused.status, `${method} ${path} answered ${JSON.stringify(refused.body)}`).toBe(403);
      expect((refused.body as { error: string }).error).toMatch(/code/);
    }
    const from = mail.received.length;
    expect((await rootCall('/api/auth/confirm/code', { body: {}, cookie: patCookie })).status).toBe(200);
    const confirmCode = await mailed(patEmail, SUBJECTS.confirm, from);
    const withCodePassword = fresh('pat');
    const withCode = await rootCall('/api/auth/password', { body: { password: withCodePassword, current: patPassword, code: confirmCode }, cookie: patCookie });
    expect(withCode.status, JSON.stringify(withCode.body)).toBe(200);
    patPassword = withCodePassword;
    patCookie = withCode.cookie;
    expect(await me(patCookie)).toBe(200);
  });

  it('sends one account at most five confirmation codes in fifteen minutes, so a stolen cookie cannot mail its owner endlessly', async () => {
    for (let n = 0; n < 4; n += 1) expect((await rootCall('/api/auth/confirm/code', { body: {}, cookie: patCookie })).status).toBe(200);
    const sixth = await rootCall('/api/auth/confirm/code', { body: {}, cookie: patCookie });
    expect(sixth.status, JSON.stringify(sixth.body)).toBe(429);
    expect((sixth.body as { error: string }).error).toMatch(/5 confirmation codes in the last 15 minutes/);
  });

  it('signing out on root makes the old cookie useless and closes the connection made with it', async () => {
    const patSocket = await opened(root.url, patCookie);
    expect((await rootCall('/api/auth/logout', { body: {}, cookie: patCookie })).status).toBe(200);
    expect(await me(patCookie)).toBe(401);
    expect(await patSocket.closed).toBe('io server disconnect');
    signedOutCookie = patCookie;
  });

  it('wrong two-factor codes count per account across sign-ins: a fresh password sign-in does not start the count again', async () => {
    const signIn = async () => {
      const from = mail.received.length;
      const answer = await rootCall('/api/auth/login', { body: { email: patEmail, password: patPassword } });
      if (answer.status !== 200) return { status: answer.status, body: answer.body, challenge: '', code: '' };
      return { status: answer.status, body: answer.body, challenge: (answer.body as { challenge: string }).challenge, code: await mailed(patEmail, SUBJECTS.signIn, from) };
    };
    const verify = (challenge: string, code: string) => rootCall('/api/auth/2fa/verify', { body: { challenge, code } });
    const signedInNow = await signIn();
    const throughCode = await verify(signedInNow.challenge, signedInNow.code);
    expect(throughCode.status, JSON.stringify(throughCode.body)).toBe(200);
    stillSignedIn = throughCode.cookie;
    const first = await signIn();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    for (let n = 0; n < 3; n += 1) expect((await verify(first.challenge, wrongFor(first.code))).status).toBe(400);
    const second = await signIn();
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect((await verify(second.challenge, wrongFor(second.code))).status).toBe(400);
    const locked = await verify(second.challenge, wrongFor(second.code));
    expect(locked.status, JSON.stringify(locked.body)).toBe(429);
    expect((await verify(second.challenge, second.code)).status).toBe(429);
    const third = await rootCall('/api/auth/login', { body: { email: patEmail, password: patPassword } });
    expect(third.status, JSON.stringify(third.body)).toBe(429);
    expect((third.body as { error: string }).error).toMatch(/wrong codes/);
  });

  it('ten wrong passwords lock the account to other browsers and tell its person once, ending none of their sessions; the lock and a signed-out session both survive root restarting', async () => {
    onTestFailed(() => console.log(`── root ──\n${root.logs(80)}`));
    const stillOpen = await opened(root.url, stillSignedIn);
    for (let n = 0; n < 10; n += 1) expect((await rootCall('/api/auth/login', { body: { email: patEmail, password: `wrong-${n}-password` } })).status).toBe(401);
    const lockedOut = await rootCall('/api/auth/login', { body: { email: patEmail, password: patPassword } });
    expect(lockedOut.status, JSON.stringify(lockedOut.body)).toBe(429);
    expect((lockedOut.body as { error: string }).error).toMatch(/failed sign-ins/);
    await until(async () => (mailsTo(patEmail, SUBJECTS.lock).length > 0 ? true : undefined));
    const told = mailsTo(patEmail, SUBJECTS.lock).map(textOf);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/tried your Koala password 10 times from \S+/);
    expect(told[0]).toMatch(/locked to other browsers for 15 minutes/);
    expect(told[0]).toMatch(/you may want to change your password/);
    expect(await me(stillSignedIn)).toBe(200);
    expect(stillOpen.socket.connected).toBe(true);
    await root.stop();
    await root.start();
    const stillLocked = await rootCall('/api/auth/login', { body: { email: patEmail, password: patPassword } });
    expect(stillLocked.status, JSON.stringify(stillLocked.body)).toBe(429);
    expect(await me(signedOutCookie)).toBe(401);
    expect(await me(owner.cookie)).toBe(200);
    expect(await me(stillSignedIn)).toBe(200);
    expect(mailsTo(patEmail, SUBJECTS.lock)).toHaveLength(1);
  });
}, 300_000);
