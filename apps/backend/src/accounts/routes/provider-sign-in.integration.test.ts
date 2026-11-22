import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authRouter } from './auth.js';
import { devicesFor } from './device.js';
import { INTERACTION_GONE } from './interaction.js';
import { rootAuthOver } from '../../platform/testing/root-auth.js';
import { PasswordService } from '../services/PasswordService.js';
import { breachedFrom } from '../lib/passwords.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { AuthService } from '../services/AuthService.js';
import { SignInProviders } from '../services/sign-in/SignInProviders.js';
import { GITHUB_ISSUER, providerCallbackUrl, signInProvidersFrom, type SignInProvider } from '../lib/sign-in-providers.js';
import { inviteCodeHash } from '../../platform/lib/invite-codes.js';
import { INTERACTION_PATH, START_PATH } from '../../instances/lib/oidc.js';
import { interactionAt, type Interaction } from '../testing/interaction-driver.js';
import { startStandInIssuer, type StandInIssuer } from '../testing/stand-in-issuer.js';
import { openRoutesOf } from '../../open-routes.js';

const fresh = await emptiedEachTime();

const SETUP_CODE = 'the-setup-code';
const APP_URL = 'http://localhost:5173';

const listening = async (): Promise<{ server: http.Server; url: string }> => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

interface StandInGithub {
  provider: (publicUrl: string) => SignInProvider;
  person: { id: number; emails: { email: string; primary?: boolean; verified?: boolean }[] };
  challenges: string[];
  close: () => Promise<void>;
}

async function standInGithub(): Promise<StandInGithub> {
  const { server, url } = await listening();
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const tokens = new Set<string>();
  const challenges: string[] = [];
  const github: StandInGithub = {
    person: { id: 4242, emails: [{ email: 'octo@example.com', primary: true, verified: true }] },
    challenges,
    provider: (_publicUrl: string) => ({ id: 'github', label: 'GitHub', kind: 'github', issuer: GITHUB_ISSUER, scopes: ['user:email'], clientId: 'gh-id', clientSecret: 'gh-secret', github: { authorization: `${url}/login/oauth/authorize`, token: `${url}/login/oauth/access_token`, api: `${url}/api` } }),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  const app = express();
  app.get('/login/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query as Record<string, string>;
    if (client_id !== 'gh-id' || code_challenge_method !== 'S256' || !code_challenge) return res.status(400).send('bad request');
    challenges.push(code_challenge);
    const code = randomBytes(8).toString('hex');
    codes.set(code, { challenge: code_challenge, redirect: redirect_uri! });
    return res.redirect(`${redirect_uri}?code=${code}&state=${encodeURIComponent(state!)}`);
  });
  app.post('/login/oauth/access_token', express.urlencoded({ extended: false }), (req, res) => {
    const { client_id, client_secret, code, code_verifier, redirect_uri } = req.body as Record<string, string>;
    const held = code ? codes.get(code) : undefined;
    codes.delete(code ?? '');
    const verified = held && code_verifier && createHash('sha256').update(code_verifier).digest('base64url') === held.challenge;
    if (client_id !== 'gh-id' || client_secret !== 'gh-secret' || !verified || redirect_uri !== held.redirect) return res.status(400).json({ error: 'bad_verification_code' });
    const token = randomBytes(8).toString('hex');
    tokens.add(token);
    return res.json({ access_token: token, token_type: 'bearer', scope: 'user:email' });
  });
  const signedIn = (req: express.Request) => tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  app.get('/api/user', (req, res) => (signedIn(req) ? res.json({ id: github.person.id, login: 'octo' }) : res.status(401).end()));
  app.get('/api/user/emails', (req, res) => (signedIn(req) ? res.json(github.person.emails) : res.status(401).end()));
  server.on('request', app);
  return github;
}

const CODE_KEY = 'the-data-key-codes-are-kept-with';

async function serve(db: Database, { server, url }: { server: http.Server; url: string }, providers: SignInProvider[], returnUrl?: string) {
  const root = rootAuthOver(db, { publicUrl: url, open: openRoutesOf('root'), setupCode: SETUP_CODE });
  const { auth } = root;
  const authService = new AuthService(db, { codeKey: CODE_KEY });
  const signInProviders = new SignInProviders({ providers, publicUrl: url, returnUrl, accounts: authService });
  const devices = devicesFor({ auth, store: db.accounts, authService, revocations: root.revocations });
  const app = express();
  app.use(express.json());
  app.use('/api', auth.requireAuth);
  root.mount(app, { authService, codeKey: CODE_KEY, appUrl: APP_URL, providers: signInProviders, devices });
  app.use('/api/auth', authRouter({
    db, authService, auth, devices, codeKey: CODE_KEY, appUrl: APP_URL, start: START_PATH, interactionPath: INTERACTION_PATH,
    revocations: root.revocations,
    providers: signInProviders,
    passwords: new PasswordService({ db, codeKey: CODE_KEY, auth: authService, breached: breachedFrom('') }),
  }));
  server.on('request', app);
  return { server, authService, url };
}

interface Returned {
  answer: Response;
  location: URL | undefined;
  session: string | undefined;
}

const cookiesIn = (interaction: Interaction): string => [...interaction.jar].map(([name, value]) => `${name}=${value}`).join('; ');
const errorOf = (returned: Returned): string | null => returned.location?.searchParams.get('authError') ?? null;
const uidOf = (interaction: Interaction): string => interaction.path.split('/').at(-1)!;

async function finished(interaction: Interaction, at: string, answer: Response): Promise<Returned> {
  const location = answer.headers.get('location');
  const url = location ? new URL(location, at) : undefined;
  if (!url || url.searchParams.has('resume')) return { answer, location: url, session: undefined };
  const landed = await interaction.onward(answer, (next) => next.hash.startsWith('#'));
  const held = [...interaction.jar].find(([name]) => name === 'koala_sid');
  const session = held ? `${held[0]}=${held[1]}` : undefined;
  const me = await fetch(`${at}/api/auth/me`, { headers: { cookie: session ?? '' } });
  return { answer, location: landed, session: me.status === 200 ? session : undefined };
}

async function cameBack(interaction: Interaction, at: string, callback: URL, cookie: string = cookiesIn(interaction)): Promise<Returned> {
  const back = await fetch(callback, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  if (back.status !== 302) return { answer: back, location: undefined, session: undefined };
  const onward = new URL(back.headers.get('location')!, at);
  return finished(interaction, at, await interaction.ask(`${onward.pathname}${onward.search}`));
}

describe('signing in with an OpenID provider and with GitHub', () => {
  let db: Database;
  let issuer: StandInIssuer;
  let github: StandInGithub;
  let app: Awaited<ReturnType<typeof serve>>;

  beforeEach(async () => {
    db = await fresh();
    await db.init();
    github = await standInGithub();
    const place = await listening();
    issuer = await startStandInIssuer({ redirectUris: [providerCallbackUrl(place.url, 'oidc')] });
    app = await serve(db, place, [
      ...signInProvidersFrom({ OIDC_ISSUER: issuer.issuer, OIDC_CLIENT_ID: issuer.clientId, OIDC_CLIENT_SECRET: issuer.clientSecret, OIDC_LABEL: 'Stand-in' }).providers,
      github.provider(place.url),
    ]);
  });

  afterEach(async () => {
    await issuer.close();
    await github.close();
    await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  });

  const start = async (id: string, invite?: string) => {
    const interaction = await interactionAt(app.url);
    const started = await interaction.ask(`${interaction.path}/provider/${id}${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`);
    return { interaction, started };
  };

  async function signIn(id: 'oidc' | 'github', invite?: string, back: (callback: URL) => URL = (callback) => callback, cookie?: (interaction: Interaction) => string) {
    const { interaction, started } = await start(id, invite);
    expect(started.status).toBe(302);
    expect(interaction.jar.get('koala_interaction')).toBe(uidOf(interaction));
    const callback = id === 'oidc' ? await issuer.authorize(started.headers.get('location')!) : await githubAuthorize(started.headers.get('location')!);
    expect(callback.href.startsWith(`${app.url}/api/auth/provider/${id}/callback?`)).toBe(true);
    return cameBack(interaction, app.url, back(callback), cookie ? cookie(interaction) : undefined);
  }

  async function githubAuthorize(location: string): Promise<URL> {
    const answer = await fetch(location, { redirect: 'manual' });
    return new URL(answer.headers.get('location')!);
  }

  it('lists only the providers configured, and starting any other answers 404', async () => {
    expect(await (await fetch(`${app.url}/api/auth/sign-in`)).json()).toEqual({ url: START_PATH, providers: [{ id: 'oidc', label: 'Stand-in' }, { id: 'github', label: 'GitHub' }] });
    const { interaction, started } = await start('google');
    expect(started.status).toBe(404);
    expect((await interaction.ask(`${interaction.path}/provider/google/callback?code=x&state=y`)).status).toBe(404);
  });

  it('asks the provider with PKCE (S256), a state and a nonce, for openid, email and profile only', async () => {
    const { started } = await start('oidc');
    const asked = new URL(started.headers.get('location')!).searchParams;
    expect(asked.get('code_challenge_method')).toBe('S256');
    expect(asked.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(asked.get('state')).toMatch(/^[\w-]{32}$/);
    expect(asked.get('nonce')).toBeTruthy();
    expect(asked.get('scope')).toBe('openid email profile');
    expect(asked.get('redirect_uri')).toBe(`${app.url}/api/auth/provider/oidc/callback`);
  });

  it('makes no account without an invite, makes one with it, and later signs that person in by their subject alone', async () => {
    await db.accounts.saveUser({ id: 'first', email: 'first@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString(), roles: ['operator'] });
    await db.accounts.saveInvite({ id: 'inv', codeHash: inviteCodeHash('INVITE-1'), createdBy: 'first', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    issuer.signInAs({ sub: 'sub-ann', email: 'ann@example.com', email_verified: true });

    const uninvited = await signIn('oidc');
    expect(uninvited.session).toBeUndefined();
    expect(errorOf(uninvited)).toMatch(/invite/i);
    expect(await db.accounts.getUserByEmail('ann@example.com')).toBeUndefined();

    const invited = await signIn('oidc', 'INVITE-1');
    expect(`${invited.location!.origin}${invited.location!.pathname}${invited.location!.hash}`).toBe(`${app.url}/#/`);
    const session = invited.session!;
    expect(session).toBeTruthy();
    const made = await db.accounts.getUserByEmail('ann@example.com');
    expect(made).toMatchObject({ emailVerified: true, signInLinks: [{ issuer: issuer.issuer, subject: 'sub-ann' }] });
    expect(((await (await fetch(`${app.url}/api/auth/me`, { headers: { cookie: session } })).json()) as { id: string }).id).toBe(made!.id);

    issuer.signInAs({ sub: 'sub-ann', email: 'ann-renamed@example.com', email_verified: false });
    const later = await signIn('oidc');
    expect(`${later.location!.pathname}${later.location!.hash}`).toBe('/#/');
    expect(later.session).toBeTruthy();
    expect((await db.accounts.getUsers()).length).toBe(2);
  });

  it('joins an account by an address both the provider and the account confirmed, refuses one linked to another subject, and asks the second factor', async () => {
    const ann = { id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: false, createdAt: new Date().toISOString() };
    await db.accounts.saveUser(ann);
    issuer.signInAs({ sub: 'sub-ann', email: 'ann@example.com', email_verified: true });
    expect(errorOf(await signIn('oidc'))).toContain('that address was never confirmed, so Stand-in cannot join it');

    issuer.signInAs({ sub: 'sub-ann', email: 'ann@example.com', email_verified: false });
    await db.accounts.saveUser({ ...ann, emailVerified: true });
    expect(errorOf(await signIn('oidc'))).toContain('Stand-in does not say ann@example.com is verified');

    issuer.signInAs({ sub: 'sub-ann', email: 'ann@example.com', email_verified: true });
    await db.accounts.saveUser({ ...ann, emailVerified: true, twoFactorEnabled: true });
    vi.spyOn(app.authService, 'send2FACode').mockResolvedValue(undefined);
    const asked = await signIn('oidc');
    expect(asked.location!.searchParams.get('secondFactor')).toBe('1');
    expect(asked.session).toBeUndefined();
    expect((await db.accounts.getUserById('ann'))?.signInLinks).toEqual([{ issuer: issuer.issuer, subject: 'sub-ann' }]);

    issuer.signInAs({ sub: 'sub-someone-else', email: 'ann@example.com', email_verified: true });
    expect(errorOf(await signIn('oidc'))).toContain('ann@example.com is linked to another Stand-in account');
  });

  it('refuses a sign-in coming back to another browser, with another state, or to another provider\'s callback', async () => {
    await db.accounts.saveUser({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString(), signInLinks: [{ issuer: issuer.issuer, subject: 'sub-ann' }] });
    issuer.signInAs({ sub: 'sub-ann', email: 'ann@example.com', email_verified: true });
    const nowhere = await signIn('oidc', undefined, undefined, () => '');
    expect(nowhere.answer.status).toBe(400);
    expect(await nowhere.answer.text()).toContain(INTERACTION_GONE);
    expect(nowhere.session).toBeUndefined();

    const another = await start('oidc');
    const mine = await start('oidc');
    const elsewhere = await cameBack(another.interaction, app.url, await issuer.authorize(mine.started.headers.get('location')!));
    expect(errorOf(elsewhere)).toContain('did not start here');
    expect(elsewhere.session).toBeUndefined();

    const otherState = await signIn('oidc', undefined, (callback) => { const changed = new URL(callback); changed.searchParams.set('state', 'A'.repeat(32)); return changed; });
    expect(errorOf(otherState)).toContain('did not start here');

    const crossed = await signIn('oidc', undefined, (callback) => new URL(`${callback.pathname.replace('/oidc/', '/github/')}${callback.search}`, callback));
    expect(errorOf(crossed)).toContain('did not start here');

    expect((await signIn('oidc')).session).toBeTruthy();
  });

  it.each([
    ['signature', /signature/i],
    ['audience', /aud/i],
    ['nonce', /nonce/i],
    ['issuer', /iss/i],
  ] as const)('refuses an ID token with a wrong %s', async (mischief, said) => {
    await db.accounts.saveUser({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString(), signInLinks: [{ issuer: issuer.issuer, subject: 'sub-ann' }] });
    issuer.signInAs({ sub: 'sub-ann', email: 'ann@example.com', email_verified: true });
    issuer.mischief(mischief);
    const refused = await signIn('oidc');
    expect(refused.session).toBeUndefined();
    expect(errorOf(refused)).toMatch(/^Stand-in did not sign you in: /);
    expect(errorOf(refused)).toMatch(said);
    issuer.mischief('none');
    expect((await signIn('oidc')).session).toBeTruthy();
  });

  it('signs in with GitHub through PKCE, by the account id and its primary verified address', async () => {
    await db.accounts.saveUser({ id: 'octo', email: 'octo@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString() });
    const signedIn = await signIn('github');
    expect(`${signedIn.location!.pathname}${signedIn.location!.hash}`).toBe('/#/');
    expect(signedIn.session).toBeTruthy();
    expect(github.challenges).toHaveLength(1);
    expect((await db.accounts.getUserById('octo'))?.signInLinks).toEqual([{ issuer: GITHUB_ISSUER, subject: '4242' }]);

    github.person.emails = [{ email: 'octo@example.com', verified: true }];
    await db.accounts.saveUser({ id: 'octo', email: 'octo@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString() });
    expect(errorOf(await signIn('github'))).toBe('GitHub did not sign you in: GitHub gave no primary email address; add one there, or sign in with your password');
  });

  it.each(['oidc', 'github'] as const)('refuses a %s code exchanged with another verifier than the one its challenge came from', async (id) => {
    await db.accounts.saveUser({ id: 'ann', email: 'octo@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString() });
    issuer.signInAs({ sub: 'sub-ann', email: 'octo@example.com', email_verified: true });
    const { interaction, started } = await start(id);
    const location = started.headers.get('location')!;
    const callback = id === 'oidc' ? await issuer.authorize(location) : await githubAuthorize(location);
    const stored = (await db.instances.oidcFind('Interaction', uidOf(interaction)))!;
    const result = stored.result as { koala: { provider: { verifier: string } } };
    result.koala.provider.verifier = randomBytes(32).toString('base64url');
    await db.instances.oidcUpsert('Interaction', uidOf(interaction), stored, 600);
    const refused = await cameBack(interaction, app.url, callback);
    expect(refused.session).toBeUndefined();
    expect(errorOf(refused)).toMatch(id === 'oidc' ? /^Stand-in did not sign you in: .*(PKCE|grant)/i : /^GitHub did not sign you in: bad_verification_code/);
  });

  it('refuses the old mock codes whether or not a provider has keys set: nothing signs in without the provider', async () => {
    await db.accounts.saveUser({ id: 'ann', email: 'mock-google-user@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString(), signInLinks: [{ issuer: 'https://accounts.google.com', subject: 'google-mock-id' }] });
    for (const old of ['/api/auth/google/callback?code=mock-google-code&state=x', '/api/auth/github/callback?code=mock-github-code&state=x', '/api/auth/google', '/api/auth/github']) {
      const answer = await fetch(`${app.url}${old}`, { redirect: 'manual' });
      expect(answer.status, old).toBe(401);
      expect(answer.headers.getSetCookie().some((line) => /^koala_sid=./.test(line)), old).toBe(false);
    }
    const { interaction } = await start('oidc');
    const unconfigured = await cameBack(interaction, app.url, new URL(`${app.url}/api/auth/provider/google/callback?code=mock-google-code&state=x`));
    expect(unconfigured.answer.status).toBe(404);
    expect(unconfigured.session).toBeUndefined();

    const keyed = await serve(db, await listening(), signInProvidersFrom({ GOOGLE_CLIENT_ID: 'real-id', GOOGLE_CLIENT_SECRET: 'real-secret' }).providers);
    try {
      expect(await (await fetch(`${keyed.url}/api/auth/sign-in`)).json()).toEqual({ url: START_PATH, providers: [{ id: 'google', label: 'Google' }] });
      const unstarted = await interactionAt(keyed.url);
      unstarted.jar.set('koala_interaction', uidOf(unstarted));
      const mock = await cameBack(unstarted, keyed.url, new URL(`${keyed.url}/api/auth/provider/google/callback?code=mock-google-code&state=x`));
      expect(mock.answer.status).toBe(302);
      expect(mock.session).toBeUndefined();
      expect(errorOf(mock)).toContain('did not start here');
    } finally {
      await new Promise<void>((resolve) => { keyed.server.closeAllConnections(); keyed.server.close(() => resolve()); });
    }

    issuer.signInAs({ sub: 'google-mock-id', email: 'mock-google-user@example.com', email_verified: true });
    const swapping = await start('oidc');
    const callback = await issuer.authorize(swapping.started.headers.get('location')!);
    callback.searchParams.set('code', 'mock-google-code');
    const swapped = await cameBack(swapping.interaction, app.url, callback);
    expect(swapped.session).toBeUndefined();
    expect(errorOf(swapped)).toMatch(/^Stand-in did not sign you in: /);
  });
});

describe('a dev box whose providers return to localhost while its sign-in lives on another name', () => {
  let db: Database;
  let issuer: StandInIssuer;
  let place: { server: http.Server; url: string };
  let returnUrl: string;

  beforeEach(async () => {
    db = await fresh();
    await db.init();
    place = await listening();
    returnUrl = place.url.replace('127.0.0.1', 'localhost');
    issuer = await startStandInIssuer({ redirectUris: [providerCallbackUrl(returnUrl, 'oidc')] });
    const providers = signInProvidersFrom({ OIDC_ISSUER: issuer.issuer, OIDC_CLIENT_ID: issuer.clientId, OIDC_CLIENT_SECRET: issuer.clientSecret, OIDC_LABEL: 'Stand-in' }).providers;
    await serve(db, place, providers, returnUrl);
  });

  afterEach(async () => {
    await issuer.close();
    await new Promise<void>((resolve) => { place.server.closeAllConnections(); place.server.close(() => resolve()); });
  });

  it('asks the provider to return to localhost, sends that return on to its own name where the sign-in\'s cookie is, and signs the person in there', async () => {
    await db.accounts.saveUser({ id: 'first', email: 'first@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString(), roles: ['operator'] });
    await db.accounts.saveInvite({ id: 'inv', codeHash: inviteCodeHash('INVITE-1'), createdBy: 'first', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    issuer.signInAs({ sub: 'sub-dev', email: 'dev@example.com', email_verified: true });

    const interaction = await interactionAt(place.url);
    const started = await interaction.ask(`${interaction.path}/provider/oidc?invite=INVITE-1`);
    expect(new URL(started.headers.get('location')!).searchParams.get('redirect_uri')).toBe(`${returnUrl}/api/auth/provider/oidc/callback`);

    const callback = await issuer.authorize(started.headers.get('location')!);
    expect(callback.origin).toBe(returnUrl);
    const returned = await fetch(callback, { redirect: 'manual' });
    expect(returned.status).toBe(302);
    expect(returned.headers.getSetCookie().some((line) => /^koala_sid=./.test(line))).toBe(false);
    const onward = new URL(returned.headers.get('location')!);
    expect(onward.origin).toBe(place.url);
    expect(onward.pathname + onward.search).toBe(callback.pathname + callback.search);

    const finishedThere = await cameBack(interaction, place.url, onward);
    expect(`${finishedThere.location!.origin}${finishedThere.location!.pathname}${finishedThere.location!.hash}`).toBe(`${place.url}/#/`);
    expect(finishedThere.session).toBeTruthy();
    expect(await db.accounts.getUserByEmail('dev@example.com')).toMatchObject({ signInLinks: [{ issuer: issuer.issuer, subject: 'sub-dev' }] });
  });
});
