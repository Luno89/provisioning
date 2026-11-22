import { randomUUID } from 'node:crypto';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { deviceToken } from '../../platform/lib/auth.js';
import { inviteCodeHash } from '../../platform/lib/invite-codes.js';
import { principalOf } from '../../platform/lib/permissions.js';
import type { AccessRevoked } from '../../platform/lib/revocations.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { rootAuthOver } from '../../platform/testing/root-auth.js';
import { injectedFetch } from '../../platform/testing/injected-fetch.js';
import type { HarnessUser } from '../../platform/routes/test-harness.js';
import { INTERACTION_PATH, START_PATH } from '../../instances/lib/oidc.js';
import { SIGN_UP_WRONG_CODES } from '../lib/sign-up.js';
import { codeHash } from '../lib/codes.js';
import type { AuthService } from '../services/AuthService.js';
import type { PasswordService } from '../services/PasswordService.js';
import type { SignInProviders } from '../services/sign-in/SignInProviders.js';
import type { CookieJar } from '../services/sign-in/password-at-root.js';
import { interactionAt, type Interaction } from '../testing/interaction-driver.js';
import { authRouter } from './auth.js';
import { devicesFor } from './device.js';
import { INTERACTION_GONE } from './interaction.js';
import { openRoutesOf } from '../../open-routes.js';

const KEY = 'test-secret';
const CODE_KEY = 'the-data-key-codes-are-kept-with';
const SETUP = 'the-setup-code';
const APP = 'http://localhost:5173';
const PREFIX = '/api/auth';
const NOBODY = 'nobody';

interface Answer {
  status: number;
  data: unknown;
  cookies: string[];
  headers: Headers;
}

interface Asked {
  user?: HarnessUser;
  cookie?: string;
  headers?: Record<string, string>;
}

const answerOf = async (response: Response): Promise<Answer> => {
  const text = await response.text();
  let data: unknown = text === '' ? undefined : text;
  try { data = text === '' ? undefined : JSON.parse(text) as unknown; } catch { data = text; }
  return { status: response.status, data, cookies: response.headers.getSetCookie(), headers: response.headers };
};

function set(options: { accounts?: boolean; withProviders?: boolean } = {}) {
  const db = memoryDatabase();
  const root = rootAuthOver(db, { open: openRoutesOf('root'), setupCode: SETUP });
  const authService = mock<AuthService>();
  const passwords = mock<Pick<PasswordService, 'newPasswordProblem'>>();
  const providers = mock<Pick<SignInProviders, 'offered' | 'start' | 'finish' | 'returnedElsewhere' | 'callbackUrl'>>();
  providers.callbackUrl.mockImplementation((path) => new URL(path, 'https://koala.example'));
  const revoked: AccessRevoked[] = [];
  root.revocations.listen(async (event) => { revoked.push(event); });
  const as = new Map<string, HarnessUser>();
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const named = req.get('x-test-as');
    if (named === NOBODY) return next();
    const user = named ? as.get(named) : undefined;
    if (!user) return root.auth.requireAuth(req, res, next);
    (req as unknown as { user: HarnessUser }).user = user;
    (req as unknown as { principal: ReturnType<typeof principalOf> }).principal = principalOf(user, { role: 'root' });
    return next();
  });
  root.mount(app, {
    authService, appUrl: APP, codeKey: CODE_KEY,
    devices: devicesFor({ auth: root.auth, sessionKey: KEY, authService }),
    providers: options.withProviders === false ? undefined : providers,
  });
  app.use(PREFIX, authRouter({
    db, authService, auth: root.auth, sessionKey: KEY, codeKey: CODE_KEY, appUrl: APP, passwords, start: START_PATH, interactionPath: INTERACTION_PATH,
    accounts: options.accounts,
    revocations: root.revocations,
    providers: options.withProviders === false ? undefined : providers,
  }));
  const send = injectedFetch(app);
  const call = async (method: 'GET' | 'POST', path: string, body: unknown, asked: Asked): Promise<Answer> => {
    const who = asked.user ? (() => { const named = randomUUID(); as.set(named, asked.user); return { 'x-test-as': named }; })() : asked.cookie ? { cookie: asked.cookie } : { 'x-test-as': NOBODY };
    return answerOf(await send(new URL(path, root.publicUrl), {
      method, redirect: 'manual',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...who, ...asked.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  };
  const post = (path: string, body: unknown, asked: Asked = {}) => call('POST', `${PREFIX}${path}`, body, asked);
  const get = (path: string, asked: Asked = {}) => call('GET', `${PREFIX}${path}`, undefined, asked);
  const me = (cookie: string | undefined) => call('GET', `${PREFIX}/me`, undefined, cookie ? { cookie } : {});
  const holds = async (cookie: string | undefined): Promise<string | undefined> => {
    if (!cookie) return undefined;
    const answer = await me(cookie);
    return answer.status === 200 ? (answer.data as { id: string }).id : undefined;
  };
  const begin = (jar?: CookieJar): Promise<Interaction> => interactionAt(root.publicUrl, send, jar);
  return { db, root, authService, passwords, providers, revoked, post, get, me, holds, begin };
}

type Set = ReturnType<typeof set>;

const cookieOf = (answer: Answer, name: string): string | undefined => answer.cookies.map((line) => line.split(';')[0]!).find((pair) => pair.startsWith(`${name}=`));
const sessionIn = (interaction: Interaction): string | undefined => {
  const held = [...interaction.jar].find(([name]) => /^(__Host-)?koala_sid$/.test(name));
  return held && `${held[0]}=${held[1]}`;
};
const uidOf = (interaction: Interaction): string => interaction.path.split('/').at(-1)!;
const nextOf = (answer: Answer): string => (answer.data as { next: string }).next;
const annSignedInBy = async (s: Set, interaction: Interaction, answer: Answer): Promise<unknown> => {
  expect(answer.status).toBe(200);
  expect(answer.data).toEqual({ next: expect.any(String) as string });
  expect(cookieOf(answer, 'device')).toBeDefined();
  const { cookie } = await interaction.followed(nextOf(answer));
  expect(await s.holds(cookie)).toBe('ann');
  return (await s.me(cookie)).data;
};

const member = (extra: Partial<UserMetadata> = {}): UserMetadata => ({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: '2026-01-01', ...extra });

const withInvite = async (s: Set, code: string) => {
  await s.db.accounts.saveInvite({ id: `inv-${code}`, codeHash: inviteCodeHash(code), createdBy: 'first', createdAt: new Date().toISOString() });
};

async function signUp(s: Set, email: string, invite: string) {
  await withInvite(s, invite).catch(() => undefined);
  s.authService.sendSignUpCode.mockImplementation(async (_to, code) => ({ kind: 'shown', code }));
  const answer = await s.post('/register', { email, password: 'hunter2hunter2', inviteCode: invite });
  const body = answer.data as { verify?: string; devCode?: string; error?: string };
  return { answer, id: body.verify!, code: body.devCode! };
}

async function withFirstUser(s: Set) {
  await s.db.accounts.saveUser(member({ id: 'first', email: 'first@example.com', roles: ['operator'] }));
}

async function signedInTwice(s: Set, user: UserMetadata) {
  await s.db.accounts.saveUser(user);
  s.authService.checkPassword.mockResolvedValue({ kind: 'ok' });
  const here = await s.root.signedIn(user.id);
  const other = await s.root.signedIn(user.id);
  return { here: here.cookie, other: other.cookie };
}

describe('signing up', () => {
  it('makes the first account with the setup code at once, an operator whose address is not yet confirmed', async () => {
    const s = set();
    const answer = await s.post('/register', { email: ' Owner@Example.com ', password: 'hunter2hunter2', inviteCode: SETUP });
    expect(answer.data).toEqual({ success: true, message: 'User registered successfully' });
    const owner = await s.db.accounts.getUserByEmail('owner@example.com');
    expect(owner).toMatchObject({ roles: ['operator'], emailVerified: false, twoFactorEnabled: false });
    expect(owner?.passwordHash).toEqual(expect.any(String));
    expect(owner?.passwordHash).not.toContain('hunter2hunter2');
    expect(s.authService.sendSignUpCode).not.toHaveBeenCalled();
  });

  it('refuses the first sign-up without the setup code, saying where to find it', async () => {
    const s = set();
    const answer = await s.post('/register', { email: 'stranger@example.com', password: 'hunter2hunter2' });
    expect(answer.status).toBe(403);
    expect(answer.data).toEqual({ error: 'This Koala has no account yet: the first sign-up needs its setup code, which its installer printed' });
    expect(await s.db.accounts.getUsers()).toEqual([]);
  });

  it('asks for an email and a password, a real address and a strong password', async () => {
    const s = set();
    expect((await s.post('/register', { password: 'hunter2hunter2' })).status).toBe(400);
    expect((await s.post('/register', { email: 'ann@example.com' })).status).toBe(400);
    expect((await s.post('/register', { email: 'ann@example.com', password: '' })).status).toBe(400);
    const malformed = await s.post('/register', { email: 'no-at-sign', password: 'hunter2hunter2' });
    expect(malformed.status).toBe(400);
    expect(malformed.data).toEqual({ error: 'That is not an email address; check it and try again' });
    s.passwords.newPasswordProblem.mockReturnValue('Use a password of at least 12 characters');
    const weak = await s.post('/register', { email: 'ann@example.com', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.data).toEqual({ error: 'Use a password of at least 12 characters' });
    expect(s.passwords.newPasswordProblem).toHaveBeenCalledWith('short', 'ann@example.com');
  });

  it('keeps a later sign-up pending, hashing the password and the code, until the emailed code comes back', async () => {
    const s = set();
    await withFirstUser(s);
    const { answer, id, code } = await signUp(s, 'Pending@Example.com', 'CODE');
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ verify: id, devCode: code });
    expect(await s.db.accounts.getUserByEmail('pending@example.com')).toBeUndefined();
    expect((await s.db.accounts.getInviteByCode('CODE'))?.usedBy).toBeUndefined();
    const pending = await s.db.accounts.getPendingSignUp(id);
    expect(pending).toMatchObject({ email: 'pending@example.com', wrong: 0, sent: 1, codeHash: codeHash(CODE_KEY, id, code), inviteHash: inviteCodeHash('CODE') });
    expect(JSON.stringify(pending)).not.toContain(code);
    expect(JSON.stringify(pending)).not.toContain('hunter2hunter2');
  });

  it('hands back no code when the code was emailed', async () => {
    const s = set();
    await withFirstUser(s);
    await withInvite(s, 'MAILED');
    s.authService.sendSignUpCode.mockResolvedValue({ kind: 'sent' });
    const answer = await s.post('/register', { email: 'mailed@example.com', password: 'hunter2hunter2', inviteCode: 'MAILED' });
    expect(Object.keys(answer.data as object)).toEqual(['verify']);
  });

  it('refuses a later sign-up with no invite, a wrong one or one already spent', async () => {
    const s = set();
    await withFirstUser(s);
    const nobody = await s.post('/register', { email: 'second@example.com', password: 'hunter2hunter2' });
    expect(nobody.status).toBe(403);
    expect((nobody.data as { error: string }).error).toMatch(/invite code is required/i);
    expect((await s.post('/register', { email: 'second@example.com', password: 'hunter2hunter2', inviteCode: 'WRONG' })).status).toBe(403);
    await s.db.accounts.saveInvite({ id: 'used', codeHash: inviteCodeHash('USED'), createdBy: 'first', createdAt: new Date().toISOString(), usedBy: 'someone' });
    const spent = await s.post('/register', { email: 'second@example.com', password: 'hunter2hunter2', inviteCode: 'USED' });
    expect(spent.status).toBe(403);
    expect((spent.data as { error: string }).error).toMatch(/already been used/i);
    expect(s.authService.sendSignUpCode).not.toHaveBeenCalled();
  });

  it('says so when no email can be sent for the code', async () => {
    const s = set();
    await withFirstUser(s);
    await withInvite(s, 'NOMAIL');
    s.authService.sendSignUpCode.mockResolvedValue({ kind: 'refused', why: 'This server cannot send email yet' });
    const answer = await s.post('/register', { email: 'nomail@example.com', password: 'hunter2hunter2', inviteCode: 'NOMAIL' });
    expect(answer.status).toBe(503);
    expect(answer.data).toEqual({ error: 'This server cannot send email yet' });
    expect(await s.db.accounts.getPendingSignUp('anything')).toBeUndefined();
  });

  it('answers a sign-up of an address that has an account as it answers a new one, emailing that address that it has one', async () => {
    const s = set();
    await withFirstUser(s);
    await s.db.accounts.saveUser(member({ email: 'taken@example.com' }));
    await withInvite(s, 'TAKEN');
    s.authService.emailCode.mockResolvedValue({ kind: 'sent' });
    const answer = await s.post('/register', { email: 'taken@example.com', password: 'hunter2hunter2', inviteCode: 'TAKEN' });
    expect(answer.status).toBe(200);
    const id = (answer.data as { verify: string }).verify;
    expect(Object.keys(answer.data as object)).toEqual(['verify']);
    expect(s.authService.sendSignUpCode).not.toHaveBeenCalled();
    const [to, mail, code] = s.authService.emailCode.mock.calls[0] ?? [];
    expect(to).toBe('taken@example.com');
    expect(mail?.text).toContain(APP);
    expect(code).toBeUndefined();
    expect((await s.db.accounts.getPendingSignUp(id))?.taken).toBe(true);
  });

  it('answers 500 with the reason when something fails', async () => {
    const s = set();
    await withFirstUser(s);
    await withInvite(s, 'BOOM');
    s.authService.sendSignUpCode.mockRejectedValue(new Error('mail exploded'));
    const answer = await s.post('/register', { email: 'boom@example.com', password: 'hunter2hunter2', inviteCode: 'BOOM' });
    expect(answer.status).toBe(500);
    expect(answer.data).toEqual({ error: 'mail exploded' });
  });
});

describe('confirming a sign-up at the sign-in', () => {
  const verify = async (s: Set, body: { id?: unknown; code?: unknown }, interaction?: Interaction) => {
    const at = interaction ?? await s.begin();
    return answerOf(await at.signUp(body.id, body.code));
  };

  it('makes the account, spends the invite, signs in and remembers the browser when the code is right', async () => {
    const s = set();
    await withFirstUser(s);
    const { id, code } = await signUp(s, 'new@example.com', 'CODE');
    const interaction = await s.begin();
    const done = await verify(s, { id, code: ` ${code} ` }, interaction);
    expect(done.status).toBe(200);
    expect(done.data).toEqual({ next: expect.any(String) as string });
    expect(cookieOf(done, 'device')).toBeDefined();
    const { cookie } = await interaction.followed(nextOf(done));
    const body = (await s.me(cookie)).data as { email: string; permissions: Record<string, boolean>; confirmWith: string; hasPassword: boolean };
    expect(body).toMatchObject({ email: 'new@example.com', confirmWith: 'password', hasPassword: true });
    expect(body.permissions.administer).toBe(false);
    const user = await s.db.accounts.getUserByEmail('new@example.com');
    expect(user).toMatchObject({ emailVerified: true, twoFactorEnabled: false });
    expect(user?.roles).toBeUndefined();
    expect((await s.db.accounts.getInviteByCode('CODE'))?.usedBy).toBe(user?.id);
    expect(await s.db.accounts.getPendingSignUp(id)).toBeUndefined();
    expect(await s.holds(cookie)).toBe(user?.id);
  });

  it('asks for the six digits, and says a sign-up that is not there has ended', async () => {
    const s = set();
    expect((await verify(s, { id: 'x', code: 'abc' })).status).toBe(400);
    expect((await verify(s, { id: 'x' })).status).toBe(400);
    const gone = await verify(s, { id: 'no-such', code: '123456' });
    expect(gone.status).toBe(410);
    expect(gone.data).toEqual({ error: 'This sign-up has ended; sign up again' });
    expect((await verify(s, { code: '123456' })).status).toBe(410);
  });

  it('says a sign-in that is not there has ended before it looks at the sign-up', async () => {
    const s = set();
    await withFirstUser(s);
    const { id, code } = await signUp(s, 'new@example.com', 'CODE');
    const interaction = await s.begin();
    const elsewhere = await answerOf(await interaction.ask(`${INTERACTION_PATH}/not-this-sign-in/sign-up/verify`, { id, code }));
    expect(elsewhere.status).toBe(410);
    expect(elsewhere.data).toEqual({ error: INTERACTION_GONE });
    expect(await s.db.accounts.getPendingSignUp(id)).toBeDefined();
  });

  it('ends a sign-up after five wrong codes', async () => {
    const s = set();
    await withFirstUser(s);
    const { id, code } = await signUp(s, 'guess@example.com', 'GUESS');
    const interaction = await s.begin();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let n = 1; n < SIGN_UP_WRONG_CODES; n += 1) {
      const refused = await verify(s, { id, code: wrong }, interaction);
      expect(refused.status).toBe(401);
      expect(refused.data).toEqual({ error: 'That code is not the one we sent; check the email and try again' });
    }
    const last = await verify(s, { id, code: wrong }, interaction);
    expect(last.status).toBe(410);
    expect(last.data).toEqual({ error: 'That code was wrong too many times; sign up again' });
    expect((await verify(s, { id, code }, interaction)).status).toBe(410);
    expect(await s.db.accounts.getUserByEmail('guess@example.com')).toBeUndefined();
  });

  it('refuses an expired sign-up', async () => {
    const s = set();
    await withFirstUser(s);
    const { id, code } = await signUp(s, 'late@example.com', 'LATE');
    const pending = (await s.db.accounts.getPendingSignUp(id))!;
    await s.db.accounts.savePendingSignUp({ ...pending, expiresAt: new Date(Date.now() - 1000) });
    expect((await verify(s, { id, code })).status).toBe(410);
  });

  it('refuses an address that got an account while the sign-up waited, leaving the invite unspent', async () => {
    const s = set();
    await withFirstUser(s);
    const { id, code } = await signUp(s, 'taken@example.com', 'WAITED');
    await s.db.accounts.saveUser(member({ id: 'other', email: 'taken@example.com' }));
    expect((await verify(s, { id, code })).status).toBe(410);
    expect((await s.db.accounts.getInviteByCode('WAITED'))?.usedBy).toBeUndefined();
  });

  it('refuses when the invite was spent meanwhile, and makes no account', async () => {
    const s = set();
    await withFirstUser(s);
    const { id, code } = await signUp(s, 'a@example.com', 'ONCE');
    const other = await signUp(s, 'b@example.com', 'ONCE');
    expect((await verify(s, { id, code })).status).toBe(200);
    const refused = await verify(s, { id: other.id, code: other.code });
    expect(refused.status).toBe(403);
    expect(await s.db.accounts.getUserByEmail('b@example.com')).toBeUndefined();
  });

  it('answers a sign-up of an address that has an account with no way to confirm it', async () => {
    const s = set();
    await withFirstUser(s);
    await s.db.accounts.saveUser(member({ email: 'taken@example.com' }));
    await withInvite(s, 'TAKEN');
    s.authService.emailCode.mockResolvedValue({ kind: 'sent' });
    const started = await s.post('/register', { email: 'taken@example.com', password: 'hunter2hunter2', inviteCode: 'TAKEN' });
    const id = (started.data as { verify: string }).verify;
    const interaction = await s.begin();
    for (const guess of ['000000', '123456', '999999']) expect((await verify(s, { id, code: guess }, interaction)).status).toBe(401);
  });
});

describe('asking for a new sign-up code', () => {
  it('sends a new code that replaces the last, a few times at most', async () => {
    const s = set();
    await withFirstUser(s);
    const { id, code } = await signUp(s, 'again@example.com', 'AGAIN');
    const resent = await s.post('/register/resend', { id });
    expect(resent.status).toBe(200);
    const fresh = (resent.data as { verify: string; devCode: string });
    expect(fresh.verify).toBe(id);
    expect((await s.db.accounts.getPendingSignUp(id))?.codeHash).toBe(codeHash(CODE_KEY, id, fresh.devCode));
    if (fresh.devCode !== code) expect((await answerOf(await (await s.begin()).signUp(id, code))).status).toBe(401);
    for (let n = 0; n < 3; n += 1) expect((await s.post('/register/resend', { id })).status).toBe(200);
    const enough = await s.post('/register/resend', { id });
    expect(enough.status).toBe(429);
    expect(enough.data).toEqual({ error: 'We have sent this sign-up enough codes; sign up again' });
  });

  it('says a sign-up that is not there has ended', async () => {
    const s = set();
    expect((await s.post('/register/resend', { id: 'no-such' })).status).toBe(410);
    expect((await s.post('/register/resend', {})).status).toBe(410);
  });

  it('says so when no email can be sent', async () => {
    const s = set();
    await withFirstUser(s);
    const { id } = await signUp(s, 'again@example.com', 'AGAIN');
    s.authService.sendSignUpCode.mockResolvedValue({ kind: 'refused', why: 'no email here' });
    const refused = await s.post('/register/resend', { id });
    expect(refused.status).toBe(503);
    expect(refused.data).toEqual({ error: 'no email here' });
  });

  it('emails the address that it has an account when the sign-up was for a taken one, and no code', async () => {
    const s = set();
    await withFirstUser(s);
    await s.db.accounts.saveUser(member({ email: 'taken@example.com' }));
    await withInvite(s, 'TAKEN');
    s.authService.emailCode.mockResolvedValue({ kind: 'sent' });
    const started = await s.post('/register', { email: 'taken@example.com', password: 'hunter2hunter2', inviteCode: 'TAKEN' });
    const id = (started.data as { verify: string }).verify;
    s.authService.emailCode.mockClear();
    const resent = await s.post('/register/resend', { id });
    expect(resent.data).toEqual({ verify: id });
    expect(s.authService.emailCode).toHaveBeenCalledTimes(1);
    expect(s.authService.sendSignUpCode).not.toHaveBeenCalled();
  });
});

describe('signing in', () => {
  const login = async (s: Set, extra: Partial<UserMetadata> = {}) => {
    await s.db.accounts.saveUser(member({ passwordHash: 'stored', ...extra }));
  };
  const loggingIn = async (s: Set, body: unknown, jar?: CookieJar) => {
    const interaction = await s.begin(jar);
    return { interaction, answer: await answerOf(await interaction.login(body)) };
  };

  it('asks for an email and a password', async () => {
    const s = set();
    expect((await loggingIn(s, { password: 'x' })).answer.status).toBe(400);
    expect((await loggingIn(s, { email: 'ann@example.com' })).answer.status).toBe(400);
  });

  it('signs a person in when the password checks out, remembering their browser, and names the address as typed in any case', async () => {
    const s = set();
    await login(s);
    s.authService.checkPassword.mockResolvedValue({ kind: 'ok' });
    const { interaction, answer } = await loggingIn(s, { email: ' ANN@example.com ', password: 'the-password' });
    expect(await annSignedInBy(s, interaction, answer)).toMatchObject({ email: 'ann@example.com', twoFactorEnabled: false });
    expect(s.authService.checkPassword).toHaveBeenCalledWith('ann@example.com', expect.objectContaining({ id: 'ann' }), 'the-password', undefined, '127.0.0.1');
  });

  it('passes the browser it knows to the password check', async () => {
    const s = set();
    await login(s);
    s.authService.checkPassword.mockResolvedValue({ kind: 'ok' });
    await loggingIn(s, { email: 'ann@example.com', password: 'p' }, new Map([['device', deviceToken('ann@example.com', KEY, 'phone')]]));
    expect(s.authService.checkPassword).toHaveBeenCalledWith('ann@example.com', expect.anything(), 'p', { account: 'ann@example.com', id: 'phone' }, '127.0.0.1');
  });

  it('answers a wrong password and an unknown account alike', async () => {
    const s = set();
    await login(s);
    s.authService.checkPassword.mockResolvedValue({ kind: 'wrong' });
    const wrong = (await loggingIn(s, { email: 'ann@example.com', password: 'nope' })).answer;
    expect(wrong.status).toBe(401);
    expect(wrong.data).toEqual({ error: 'Invalid email or password' });
    s.authService.checkPassword.mockResolvedValue({ kind: 'ok' });
    const nobody = (await loggingIn(s, { email: 'nobody@example.com', password: 'nope' })).answer;
    expect(nobody.status).toBe(401);
    expect(nobody.data).toEqual({ error: 'Invalid email or password' });
  });

  it('says an account is locked and why', async () => {
    const s = set();
    await login(s);
    s.authService.checkPassword.mockResolvedValue({ kind: 'locked', said: 'Too many wrong passwords; try again in 15 minutes' });
    const { interaction, answer: locked } = await loggingIn(s, { email: 'ann@example.com', password: 'p' });
    expect(locked.status).toBe(429);
    expect(locked.data).toEqual({ error: 'Too many wrong passwords; try again in 15 minutes' });
    expect(await s.holds(sessionIn(interaction))).toBeUndefined();
  });

  it('refuses an account being removed', async () => {
    const s = set();
    await login(s, { removal: { startedAt: 't', requestedBy: 'ann' } });
    s.authService.checkPassword.mockResolvedValue({ kind: 'ok' });
    const { answer } = await loggingIn(s, { email: 'ann@example.com', password: 'p' });
    expect(answer.status).toBe(403);
    expect(answer.data).toEqual({ error: 'This account is being removed' });
  });

  it('says a sign-in that is not there has ended', async () => {
    const s = set();
    await login(s);
    s.authService.checkPassword.mockResolvedValue({ kind: 'ok' });
    const interaction = await s.begin();
    const gone = await answerOf(await interaction.ask(`${INTERACTION_PATH}/not-this-sign-in/login`, { email: 'ann@example.com', password: 'p' }));
    expect(gone.status).toBe(410);
    expect(gone.data).toEqual({ error: INTERACTION_GONE });
    expect(s.authService.checkPassword).not.toHaveBeenCalled();
  });

  it('sends a code and holds the two-factor step in the sign-in, never a session, when two-factor is on', async () => {
    const s = set();
    await login(s, { twoFactorEnabled: true });
    s.authService.checkPassword.mockResolvedValue({ kind: 'ok' });
    s.authService.sendCode.mockResolvedValue({ kind: 'sent' });
    const { interaction, answer } = await loggingIn(s, { email: 'ann@example.com', password: 'p' });
    expect(answer.data).toEqual({ twoFactorRequired: true });
    expect(cookieOf(answer, 'koala_sid')).toBeUndefined();
    expect(await s.holds(sessionIn(interaction))).toBeUndefined();
    expect(s.authService.sendCode).toHaveBeenCalledWith(expect.objectContaining({ id: 'ann' }), 'sign-in');
  });

  it('says codes are locked instead of sending one', async () => {
    const s = set();
    await login(s, { twoFactorEnabled: true });
    s.authService.checkPassword.mockResolvedValue({ kind: 'ok' });
    s.authService.sendCode.mockResolvedValue({ kind: 'locked', said: 'Too many wrong codes' });
    const { answer } = await loggingIn(s, { email: 'ann@example.com', password: 'p' });
    expect(answer.status).toBe(429);
    expect(answer.data).toEqual({ error: 'Too many wrong codes' });
  });

  it('answers 500 with the reason when something fails', async () => {
    const s = set();
    await login(s);
    s.authService.checkPassword.mockRejectedValue(new Error('store gone'));
    const { answer } = await loggingIn(s, { email: 'ann@example.com', password: 'p' });
    expect(answer.status).toBe(500);
    expect(answer.data).toEqual({ error: 'store gone' });
  });
});

describe('the second step of signing in', () => {
  const EXPIRED = 'This sign-in has expired; sign in again';
  const askedForCode = async (s: Set) => {
    await s.db.accounts.saveUser(member({ twoFactorEnabled: true }));
    s.authService.sendCode.mockResolvedValue({ kind: 'sent' });
    s.authService.checkPassword.mockResolvedValue({ kind: 'ok' });
    const interaction = await s.begin();
    expect((await answerOf(await interaction.login({ email: 'ann@example.com', password: 'p' }))).data).toEqual({ twoFactorRequired: true });
    return interaction;
  };

  it('signs in with a right code at the sign-in holding the two-factor step', async () => {
    const s = set();
    const interaction = await askedForCode(s);
    s.authService.checkCode.mockResolvedValue({ kind: 'ok' });
    const answer = await answerOf(await interaction.secondFactor('123456'));
    expect(await annSignedInBy(s, interaction, answer)).toMatchObject({ email: 'ann@example.com', twoFactorEnabled: true });
    expect(s.authService.checkCode).toHaveBeenCalledWith('ann', 'sign-in', '123456');
  });

  it('asks for the code', async () => {
    const s = set();
    const interaction = await askedForCode(s);
    expect((await interaction.secondFactor(undefined)).status).toBe(400);
    expect((await interaction.secondFactor('')).status).toBe(400);
    expect((await interaction.secondFactor(123456)).status).toBe(400);
    expect(s.authService.checkCode).not.toHaveBeenCalled();
  });

  it('refuses a code at a sign-in that holds no two-factor step, one that is gone, or one whose account is gone or being removed', async () => {
    const s = set();
    const unasked = await answerOf(await (await s.begin()).secondFactor('123456'));
    expect(unasked.status).toBe(400);
    expect(unasked.data).toEqual({ error: EXPIRED });
    await s.db.accounts.saveUser(member());
    s.authService.checkPassword.mockResolvedValue({ kind: 'ok' });
    const passwordOnly = await s.begin();
    expect((await answerOf(await passwordOnly.login({ email: 'ann@example.com', password: 'p' }))).status).toBe(200);
    expect((await passwordOnly.secondFactor('123456')).status).toBe(400);
    const elsewhere = await answerOf(await passwordOnly.ask(`${INTERACTION_PATH}/not-this-sign-in/second-factor`, { code: '123456' }));
    expect(elsewhere.status).toBe(410);
    expect(elsewhere.data).toEqual({ error: INTERACTION_GONE });

    const removing = set();
    const beingRemoved = await askedForCode(removing);
    await removing.db.accounts.saveUser(member({ twoFactorEnabled: true, removal: { startedAt: 't', requestedBy: 'ann' } }));
    const refused = await answerOf(await beingRemoved.secondFactor('123456'));
    expect(refused.status).toBe(400);
    expect(refused.data).toEqual({ error: EXPIRED });
    expect(removing.authService.checkCode).not.toHaveBeenCalled();

    const deleted = set();
    const ofNobody = await askedForCode(deleted);
    await deleted.db.accounts.deleteUser('ann');
    expect((await answerOf(await ofNobody.secondFactor('123456'))).data).toEqual({ error: EXPIRED });
    expect(deleted.authService.checkCode).not.toHaveBeenCalled();
  });

  it('refuses a wrong code, or says the codes are locked', async () => {
    const s = set();
    const interaction = await askedForCode(s);
    s.authService.checkCode.mockResolvedValue({ kind: 'wrong' });
    const wrong = await answerOf(await interaction.secondFactor('000000'));
    expect(wrong.status).toBe(400);
    expect(wrong.data).toEqual({ error: 'Invalid or expired 2FA code' });
    s.authService.checkCode.mockResolvedValue({ kind: 'locked', said: 'Too many wrong codes' });
    const locked = await answerOf(await interaction.secondFactor('000000'));
    expect(locked.status).toBe(429);
    expect(locked.data).toEqual({ error: 'Too many wrong codes' });
    expect(cookieOf(locked, 'koala_sid')).toBeUndefined();
    expect(await s.holds(sessionIn(interaction))).toBeUndefined();
  });
});

describe('who is signed in', () => {
  it('says nobody is when no one is', async () => {
    const answer = await set().get('/me');
    expect(answer.status).toBe(401);
    expect(answer.data).toEqual({ error: 'Not authenticated' });
  });

  it('shows the person signed in with what they may do, and no pretend admin flag', async () => {
    const s = set();
    const answer = await s.get('/me', { user: member({ twoFactorPhone: '+15550100', twoFactorPreferredMethod: 'sms', passwordHash: 'h' }) });
    expect(answer.data).toMatchObject({
      email: 'ann@example.com', twoFactorPhone: '+15550100', twoFactorPreferredMethod: 'sms', emailVerified: true, createdAt: '2026-01-01',
      confirmWith: 'password', hasPassword: true, twoFactorEnabled: false,
      permissions: { 'manage-own-account': true, administer: false },
    });
    expect('isAdmin' in (answer.data as object)).toBe(false);
  });

  it('tells an operator what an operator may do', async () => {
    const answer = await set().get('/me', { user: member({ roles: ['operator'] }) });
    expect(answer.data).toMatchObject({ claims: [{ role: 'person' }, { role: 'operator' }], permissions: { administer: true, 'manage-accounts': true } });
  });

  it('holds no accounts where accounts are root\'s: no confirmation or password in what it shows, and no sign-up or sign-in routes', async () => {
    const s = set({ accounts: false });
    const me = (await s.get('/me', { user: member({ passwordHash: 'h' }) })).data as Record<string, unknown>;
    expect('confirmWith' in me || 'hasPassword' in me).toBe(false);
    expect((await s.post('/register', { email: 'a@example.com', password: 'hunter2hunter2' })).status).toBe(404);
    expect((await s.post('/login', { email: 'a@example.com', password: 'p' })).status).toBe(404);
    expect((await s.get('/sign-in')).status).toBe(404);
  });
});

describe('signing out', () => {
  it('ends the session that asked, clears its cookie and says where its sign-in at root ends', async () => {
    const s = set();
    await s.db.accounts.saveUser(member());
    s.authService.checkPassword.mockResolvedValue({ kind: 'ok' });
    const { cookie: session } = await s.root.signedIn('ann');
    expect(await s.holds(session)).toBe('ann');
    const answer = await s.post('/logout', {}, { cookie: session });
    expect(answer.data).toEqual({ success: true, endSession: expect.stringMatching(new RegExp(`^${s.root.publicUrl}/oidc/session/end\\?`)) as string });
    expect(answer.cookies.some((line) => line.startsWith('koala_sid=;'))).toBe(true);
    expect(await s.holds(session)).toBeUndefined();
  });

  it('signs out a browser with no session without complaint', async () => {
    expect((await set().post('/logout', {})).data).toEqual({ success: true });
  });
});

describe('signing out everywhere else', () => {
  it('ends other sessions, tells the others, and keeps this browser\'s session', async () => {
    const s = set();
    const { here, other } = await signedInTwice(s, member());
    expect(await s.holds(other)).toBe('ann');
    const answer = await s.post('/sessions/end-others', {}, { cookie: here });
    expect(answer.data).toEqual({ ended: true });
    expect(s.revoked).toEqual([{ personId: 'ann', because: 'signed-out-everywhere', at: expect.any(String) as string, kept: { session: expect.any(String) as string, rootSid: expect.any(String) as string } }]);
    expect(await s.holds(other)).toBeUndefined();
    expect(await s.holds(here)).toBe('ann');
    expect(cookieOf(answer, 'koala_sid')).toBe(here);
  });

  it('asks for a session', async () => {
    const answer = await set().post('/sessions/end-others', {});
    expect(answer.status).toBe(401);
  });
});

describe('asking for a code to confirm a risky change', () => {
  it('asks for a session', async () => {
    expect((await set().post('/confirm/code', {})).status).toBe(401);
  });

  it('sends none to an account that confirms with its password', async () => {
    const s = set();
    const answer = await s.post('/confirm/code', {}, { user: member({ passwordHash: 'h' }) });
    expect(answer.status).toBe(400);
    expect(s.authService.sendConfirmCode).not.toHaveBeenCalled();
  });

  it('sends one to an account with two-factor on or no password', async () => {
    const s = set();
    s.authService.sendConfirmCode.mockResolvedValue({ kind: 'sent' });
    expect((await s.post('/confirm/code', {}, { user: member({ twoFactorEnabled: true, passwordHash: 'h' }) })).data).toEqual({ sent: true });
    expect((await s.post('/confirm/code', {}, { user: member() })).data).toEqual({ sent: true });
    expect(s.authService.sendConfirmCode).toHaveBeenCalledTimes(2);
  });

  it('answers 429 with why when too many have been sent or codes are locked', async () => {
    const s = set();
    s.authService.sendConfirmCode.mockResolvedValue({ kind: 'limited', said: 'You can have 5 confirmation codes in the last 15 minutes' });
    const limited = await s.post('/confirm/code', {}, { user: member() });
    expect(limited.status).toBe(429);
    expect(limited.data).toEqual({ error: 'You can have 5 confirmation codes in the last 15 minutes' });
    s.authService.sendConfirmCode.mockResolvedValue({ kind: 'locked', said: 'Too many wrong codes' });
    expect((await s.post('/confirm/code', {}, { user: member() })).status).toBe(429);
  });
});

describe('two-factor settings', () => {
  const asks = (s: Set) => {
    s.authService.sendingProblem.mockReturnValue(undefined);
    s.authService.confirmProblem.mockResolvedValue(undefined);
  };

  it('asks for a session', async () => {
    expect((await set().post('/2fa/settings', { enabled: true })).status).toBe(401);
  });

  it('turns two-factor on once proven, ending other sessions and keeping this one', async () => {
    const s = set();
    asks(s);
    const { here, other } = await signedInTwice(s, member({ passwordHash: 'h' }));
    const answer = await s.post('/2fa/settings', { enabled: true, phone: '+15550100', preferredMethod: 'sms', password: 'p' }, { cookie: here });
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: true, twoFactorPhone: '+15550100', twoFactorPreferredMethod: 'sms', confirmWith: 'two-factor' });
    const saved = await s.db.accounts.getUserById('ann');
    expect(saved).toMatchObject({ twoFactorEnabled: true, twoFactorPhone: '+15550100', twoFactorPreferredMethod: 'sms' });
    expect(s.revoked).toEqual([{ personId: 'ann', because: 'password-or-2fa', at: expect.any(String) as string, kept: { session: expect.any(String) as string, rootSid: expect.any(String) as string } }]);
    expect(await s.holds(other)).toBeUndefined();
    expect(await s.holds(here)).toBe('ann');
    expect(cookieOf(answer, 'koala_sid')).toBe(here);
    expect(s.authService.sendingProblem).toHaveBeenCalledWith('sms');
    expect(s.authService.confirmProblem).toHaveBeenCalledWith(expect.objectContaining({ id: 'ann' }), { password: 'p' }, undefined, '127.0.0.1');
  });

  it('turns it off, asking nothing of the way codes are sent', async () => {
    const s = set();
    asks(s);
    const { here } = await signedInTwice(s, member({ twoFactorEnabled: false, passwordHash: 'h' }));
    await s.db.accounts.saveUser(member({ twoFactorEnabled: true, passwordHash: 'h' }));
    const answer = await s.post('/2fa/settings', { enabled: false, code: '123456' }, { cookie: here });
    expect((answer.data as { twoFactorEnabled: boolean }).twoFactorEnabled).toBe(false);
    expect(s.authService.sendingProblem).not.toHaveBeenCalled();
  });

  it('stays off, saying why, where a way of sending cannot be used', async () => {
    const s = set();
    s.authService.sendingProblem.mockReturnValue('sign-in codes by SMS need Twilio, which this server does not have set up');
    const user = member();
    await s.db.accounts.saveUser(user);
    const answer = await s.post('/2fa/settings', { enabled: true, preferredMethod: 'sms' }, { user });
    expect(answer.status).toBe(400);
    expect(answer.data).toEqual({ error: 'Two-factor sign-in stays off: sign-in codes by SMS need Twilio, which this server does not have set up.' });
    expect(s.authService.confirmProblem).not.toHaveBeenCalled();
    expect((await s.db.accounts.getUserById('ann'))?.twoFactorEnabled).toBe(false);
  });

  it('uses the way the account already has when none is named', async () => {
    const s = set();
    asks(s);
    const { here } = await signedInTwice(s, member({ twoFactorPreferredMethod: 'sms' }));
    await s.post('/2fa/settings', { enabled: true }, { cookie: here });
    expect(s.authService.sendingProblem).toHaveBeenCalledWith('sms');
    s.authService.sendingProblem.mockClear();
    const bo = await signedInTwice(s, member({ id: 'bo', email: 'bo@example.com' }));
    await s.post('/2fa/settings', { enabled: true }, { cookie: bo.here });
    expect(s.authService.sendingProblem).toHaveBeenCalledWith('email');
  });

  it('changes nothing when the proof is refused', async () => {
    const s = set();
    s.authService.sendingProblem.mockReturnValue(undefined);
    s.authService.confirmProblem.mockResolvedValue({ status: 403, error: 'Enter your password to do this' });
    const user = member({ passwordHash: 'h' });
    await s.db.accounts.saveUser(user);
    const answer = await s.post('/2fa/settings', { enabled: true }, { user });
    expect(answer.status).toBe(403);
    expect(answer.data).toEqual({ error: 'Enter your password to do this' });
    expect((await s.db.accounts.getUserById('ann'))?.twoFactorEnabled).toBe(false);
    expect(s.revoked).toEqual([]);
  });

  it('refuses a body that is not a setting', async () => {
    const s = set();
    const user = member();
    expect((await s.post('/2fa/settings', { enabled: true, phone: 5 }, { user })).status).toBe(400);
    expect((await s.post('/2fa/settings', { enabled: true, preferredMethod: 'carrier-pigeon' }, { user })).status).toBe(400);
  });
});

describe('signing in with a provider', () => {
  const HELD = { provider: 'google', state: 's', verifier: 'the-verifier', nonce: 'the-nonce', invite: '' };
  const startAt = (interaction: Interaction, path: string) => interaction.ask(`${interaction.path}/provider/${path}`).then(answerOf);
  const started = async (s: Set) => {
    const interaction = await s.begin();
    s.providers.start.mockResolvedValue({ kind: 'started', url: 'https://accounts.example/authorize?state=s', held: HELD });
    expect((await startAt(interaction, 'google')).status).toBe(302);
    return interaction;
  };
  const returned = async (interaction: Interaction, query = '?code=c&state=s') => {
    const back = await answerOf(await interaction.ask(`/api/auth/provider/google/callback${query}`));
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe(`${INTERACTION_PATH}/${uidOf(interaction)}/provider/google/callback${query}`);
    return answerOf(await interaction.ask(back.headers.get('location')!));
  };
  const resumeFor = (interaction: Interaction) => `${APP}/?resume=${encodeURIComponent(interaction.path)}`;

  it('offers the providers this server has, or none, and where a sign-in starts', async () => {
    const s = set();
    s.providers.offered.mockReturnValue([{ id: 'google', label: 'Google' }]);
    expect((await s.get('/sign-in')).data).toEqual({ url: START_PATH, providers: [{ id: 'google', label: 'Google' }] });
    expect((await set({ withProviders: false }).get('/sign-in')).data).toEqual({ url: START_PATH, providers: [] });
  });

  it('sends the browser to the provider, holding the state in the sign-in and naming the sign-in in a cookie, never cached', async () => {
    const s = set();
    const interaction = await s.begin();
    s.providers.start.mockResolvedValue({ kind: 'started', url: 'https://accounts.example/authorize?state=s', held: HELD });
    const answer = await startAt(interaction, 'google?invite=CODE');
    expect(answer.status).toBe(302);
    expect(answer.headers.get('location')).toBe('https://accounts.example/authorize?state=s');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(cookieOf(answer, 'koala_interaction')).toBe(`koala_interaction=${uidOf(interaction)}`);
    expect(s.providers.start).toHaveBeenCalledWith('google', 'CODE');
  });

  it('starts with no invite when none was carried', async () => {
    const s = set();
    s.providers.start.mockResolvedValue({ kind: 'unknown' });
    await startAt(await s.begin(), 'google');
    expect(s.providers.start).toHaveBeenCalledWith('google', '');
  });

  it('says a provider this server does not offer is not there', async () => {
    const s = set();
    s.providers.start.mockResolvedValue({ kind: 'unknown' });
    const answer = await startAt(await s.begin(), 'nowhere');
    expect(answer.status).toBe(404);
    expect(answer.data).toEqual({ error: 'This server does not offer that way to sign in' });
    const without = set({ withProviders: false });
    expect((await startAt(await without.begin(), 'google')).status).toBe(404);
  });

  it('says a sign-in that is not there has ended, starting no provider', async () => {
    const s = set();
    const interaction = await s.begin();
    const gone = await answerOf(await interaction.ask(`${INTERACTION_PATH}/not-this-sign-in/provider/google`));
    expect(gone.status).toBe(410);
    expect(String(gone.data)).toContain(INTERACTION_GONE);
    expect(s.providers.start).not.toHaveBeenCalled();
  });

  it('sends the browser back to the sign-in with why when the start is refused', async () => {
    const s = set();
    s.providers.start.mockResolvedValue({ kind: 'refused', why: 'An invite is needed' });
    const interaction = await s.begin();
    const answer = await startAt(interaction, 'google');
    expect(answer.status).toBe(302);
    expect(answer.headers.get('location')).toBe(`${resumeFor(interaction)}&authError=An+invite+is+needed`);
  });

  it('signs in on the way back and sends the browser to the app', async () => {
    const s = set();
    await s.db.accounts.saveUser(member());
    const interaction = await started(s);
    s.providers.finish.mockResolvedValue({ kind: 'signed-in', user: member() });
    const answer = await returned(interaction);
    expect(answer.status).toBe(302);
    expect(answer.cookies.some((line) => line.startsWith('koala_interaction=;'))).toBe(true);
    const landed = await interaction.onward(new Response(null, { status: answer.status, headers: answer.headers }), (location) => location.hash.startsWith('#'));
    expect(`${landed.pathname}${landed.hash}`).toBe('/#/');
    const session = [...interaction.jar].find(([name]) => name === 'koala_sid');
    expect(await s.holds(session && `${session[0]}=${session[1]}`)).toBe('ann');
    const [id, url, held] = s.providers.finish.mock.calls[0] as unknown as [string, URL, unknown];
    expect(id).toBe('google');
    expect(url.pathname + url.search).toBe('/api/auth/provider/google/callback?code=c&state=s');
    expect(held).toEqual(HELD);
  });

  it('sends a return that reached another name on to the server\'s own, finishing nothing there', async () => {
    const s = set();
    s.providers.returnedElsewhere.calledWith('localhost:5175', '/api/auth/provider/google/callback?code=c&state=s').mockReturnValue('http://koala.localhost:5175/api/auth/provider/google/callback?code=c&state=s');
    const answer = await s.get('/provider/google/callback?code=c&state=s', { headers: { host: 'localhost:5175' } });
    expect(answer.status).toBe(302);
    expect(answer.headers.get('location')).toBe('http://koala.localhost:5175/api/auth/provider/google/callback?code=c&state=s');
    expect(s.providers.finish).not.toHaveBeenCalled();
    expect(cookieOf(answer, 'koala_sid')).toBeUndefined();
  });

  it('refuses a return to a browser that started no sign-in here', async () => {
    const s = set();
    const answer = await s.get('/provider/google/callback?code=c&state=s');
    expect(answer.status).toBe(400);
    expect(String(answer.data)).toContain(INTERACTION_GONE);
    expect(s.providers.finish).not.toHaveBeenCalled();
  });

  it('sends the browser back to the sign-in for its second factor when the account asks for one, and the code then signs in', async () => {
    const s = set();
    await s.db.accounts.saveUser(member({ twoFactorEnabled: true }));
    const interaction = await started(s);
    s.providers.finish.mockResolvedValue({ kind: 'second-factor', user: member({ twoFactorEnabled: true }) });
    const answer = await returned(interaction);
    expect(answer.headers.get('location')).toBe(`${resumeFor(interaction)}&secondFactor=1`);
    expect(await s.holds(sessionIn(interaction))).toBeUndefined();
    s.authService.checkCode.mockResolvedValue({ kind: 'ok' });
    const passed = await answerOf(await interaction.secondFactor('123456'));
    expect(passed.status).toBe(200);
    expect(await s.holds((await interaction.followed(nextOf(passed))).cookie)).toBe('ann');
  });

  it('sends the browser back to the sign-in with why when the sign-in is refused', async () => {
    const s = set();
    const interaction = await started(s);
    s.providers.finish.mockResolvedValue({ kind: 'refused', why: 'This account is being removed' });
    const answer = await returned(interaction);
    expect(answer.headers.get('location')).toBe(`${resumeFor(interaction)}&authError=This+account+is+being+removed`);
    expect(await s.holds(sessionIn(interaction))).toBeUndefined();
  });

  it('says a provider it does not offer is not there at the callback too, and a sign-in that is gone has ended', async () => {
    const s = set();
    s.providers.finish.mockResolvedValue({ kind: 'unknown' });
    const interaction = await s.begin();
    expect((await interaction.ask(`${interaction.path}/provider/nowhere/callback`)).status).toBe(404);
    const without = set({ withProviders: false });
    const elsewhere = await without.begin();
    expect((await elsewhere.ask(`${elsewhere.path}/provider/google/callback`)).status).toBe(404);
    const gone = await answerOf(await elsewhere.ask(`${INTERACTION_PATH}/not-this-sign-in/provider/google/callback`));
    expect(gone.status).toBe(410);
    expect(String(gone.data)).toContain(INTERACTION_GONE);
  });
});
