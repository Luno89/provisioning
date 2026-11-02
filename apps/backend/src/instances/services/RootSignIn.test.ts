import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { http, HttpResponse } from 'msw';
import { mock } from 'vitest-mock-extended';
import type { Database } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { serveInProcess } from '../testing/serve-in-process.js';
import { createAuth, type Auth } from '../../platform/middleware/auth.js';
import { SessionEnds } from '../../platform/services/SessionEnds.js';
import { sessionToken } from '../../platform/lib/auth.js';
import { type AccessRevoked } from '../../platform/lib/revocations.js';
import { sessionView, type Principal } from '../../platform/lib/permissions.js';
import { AccessRevocations } from '../../platform/services/AccessRevocations.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../lib/identity-token.js';
import { clientKeysFrom, publicJwkOf } from '../lib/oidc.js';
import { RootProvider } from './RootProvider.js';
import { InstanceReach, type ReachFetchers } from './InstanceReach.js';
import { RootSignIn } from './RootSignIn.js';
import { InstanceService, hashCredential } from './InstanceService.js';
import { oidcProviderRouter } from '../routes/oidc-provider.js';
import { signInRouter } from '../routes/sign-in.js';
import { IdentityService } from './IdentityService.js';

const containing = (text: string): unknown => expect.stringContaining(text);
const anyText = (): unknown => expect.any(String);

const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);
const having = (fields: Record<string, unknown>): unknown => expect.objectContaining(fields);

const rootSigning = identityKeysFrom(generateIdentityKey());
const ROOT_SESSION = 'root-session-key-for-the-round-trip';
const INSTANCE_SESSION = 'instance-session-key-for-the-round-trip';
const DATA_KEY = 'instance-data-key-for-the-round-trip-0001';
const HUB_SESSION = 'hub-session-key-for-the-round-trip';

type Jar = Map<string, string>;

const remember = (jar: Jar, answer: Response): void => {
  for (const line of answer.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const at = pair!.indexOf('=');
    const name = pair!.slice(0, at);
    const value = pair!.slice(at + 1);
    if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
};

const cookieOf = (jar: Jar): string => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

interface Served { url: string; app: express.Express; up: boolean }

const serve = (url: string): Served => ({ url, app: express(), up: true });

let root: Served;
let instance: Served;
let hub: Served;

const answerFor = (place: () => Served) => ({ request }: { request: Request }) => {
  const served = place();
  return served.up ? serveInProcess(served.app, request) : HttpResponse.error();
};

interceptHttp(
  http.all('http://root.test/*', answerFor(() => root)),
  http.all('http://root-alias.test/*', answerFor(() => root)),
  http.all('http://instance.test/*', answerFor(() => instance)),
  http.all('http://hub.test/*', answerFor(() => hub)),
);

const sameWorld = (): ReachFetchers => {
  const fetchers = mock<ReachFetchers>();
  fetchers.open.mockImplementation(((url: string | URL | Request, init?: RequestInit) => fetch(url, init)) as never);
  return fetchers;
};

let rootDb: Database;
let instanceDb: Database;
let provider: RootProvider;
let signIn: RootSignIn;
let hubSignIn: RootSignIn;
let instanceAuth: Auth;
let rootService: InstanceService;
let offset: number;
const heard: AccessRevoked[] = [];

beforeEach(async () => {
  rootDb = memoryDatabase();
  instanceDb = memoryDatabase();
  root = serve('http://root.test');
  instance = serve('http://instance.test');
  hub = serve('http://hub.test');
  offset = 0;
  heard.length = 0;

  await rootDb.accounts.saveUser({ id: 'u1', email: 'u1@example.com', emailVerified: true, twoFactorEnabled: false, createdAt: '2026-10-29T00:00:00.000Z' });
  await rootDb.accounts.saveUser({ id: 'u2', email: 'u2@example.com', emailVerified: true, twoFactorEnabled: false, createdAt: '2026-10-29T00:00:00.000Z' });
  await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: instance.url, credentialHash: hashCredential('the-instance-credential'), createdAt: 'x', updatedAt: 'x', status: 'ready' });

  await rootDb.instances.saveHubSignInKey({ jwk: publicJwkOf(clientKeysFrom(HUB_SESSION)), since: 'x' });
  provider = new RootProvider({ issuer: `${root.url}/oidc`, signing: rootSigning, cookieKey: 'cookie-key-for-the-round-trip', proxied: false, hubUrl: hub.url, reach: new InstanceReach({ open: true }, sameWorld()) }, rootDb);
  rootService = new InstanceService(rootDb, { rootUrl: root.url, rootPublicKeys: () => [], registry: '', imageTag: 'dev', serviceCaller: (token) => provider.serviceCaller(token) }, undefined);
  const rootAuth = createAuth({ db: rootDb, sessionKey: ROOT_SESSION, publicUrl: root.url, role: 'root', sessionEnds: new SessionEnds(rootDb.platform) });
  root.app.use('/oidc', oidcProviderRouter({ provider, signedIn: (req) => rootAuth.userFromSessionCookie(req.headers.cookie, false) }));
  root.app.put('/api/instances/sign-in-key', express.json(), async (req, res) => {
    const outcome = await rootService.announceSignIn(req.headers['x-instance-id'], String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), ((req.body ?? {}) as { jwk?: unknown }).jwk);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  });

  const revocations = new AccessRevocations();
  revocations.listen(async (event) => { heard.push(event); });
  signIn = new RootSignIn({
    kind: 'instance',
    clientId: 'inst-u1',
    rootUrl: root.url,
    publicUrl: instance.url,
    owner: 'u1',
    clientKeys: clientKeysFrom(INSTANCE_SESSION),
    trusted: trustedKeys([publicKeyPem(rootSigning.publicKey)]),
    sessionKey: INSTANCE_SESSION,
    dataKey: DATA_KEY,
    announce: { path: '/api/instances/sign-in-key', headers: { 'x-instance-id': 'inst-u1', authorization: 'Bearer the-instance-credential' } },
  }, instanceDb, revocations, () => Date.now() + offset);
  await signIn.load();
  instanceAuth = createAuth({ db: instanceDb, sessionKey: INSTANCE_SESSION, publicUrl: instance.url, role: 'instance', instanceOwnerId: 'u1', clientSessions: signIn, sessionEnds: new SessionEnds(instanceDb.platform) });
  const identity = new IdentityService({ role: 'instance', trusted: trustedKeys([publicKeyPem(rootSigning.publicKey)]), instance: { id: 'inst-u1', ownerId: 'u1', rootUrl: root.url } }, instanceDb);
  instance.app.use('/api/auth', signInRouter({ signIn, identity, auth: instanceAuth, publicUrl: instance.url, landing: '/chat' }));
  instance.app.use('/api', instanceAuth.requireAuth);
  instance.app.get('/api/whoami', (req, res) => {
    const signed = req as unknown as { user: { id: string; email: string }; principal: Principal };
    const { id, claims, permissions } = sessionView(signed.user, signed.principal, { holdsAccounts: false });
    res.json({ id, claims, permissions });
  });

  const hubDb = memoryDatabase();
  hubSignIn = new RootSignIn({
    kind: 'hub',
    clientId: 'hub',
    rootUrl: root.url,
    publicUrl: hub.url,
    clientKeys: clientKeysFrom(HUB_SESSION),
    trusted: trustedKeys([publicKeyPem(rootSigning.publicKey)]),
    sessionKey: HUB_SESSION,
    dataKey: DATA_KEY,
    announce: { path: '/api/hub-link/sign-in-key', headers: {} },
  }, hubDb, new AccessRevocations());
  const hubAuth = createAuth({ db: hubDb, sessionKey: HUB_SESSION, publicUrl: hub.url, role: 'hub', clientSessions: hubSignIn, sessionEnds: new SessionEnds(hubDb.platform) });
  const hubIdentity = new IdentityService({ role: 'hub', trusted: trustedKeys([publicKeyPem(rootSigning.publicKey)]) } as never, hubDb);
  hub.app.use('/api/auth', signInRouter({ signIn: hubSignIn, identity: hubIdentity, auth: hubAuth, publicUrl: hub.url, landing: '/hub' }));
});

async function signInAs(userId: string, at: Served = instance): Promise<{ instanceJar: Jar; landed: Response }> {
  const rootJar: Jar = new Map([['session', sessionToken({ id: userId, email: `${userId}@example.com` }, ROOT_SESSION)]]);
  const instanceJar: Jar = new Map();
  let answer = await fetch(`${at.url}/api/auth/oidc/start`, { redirect: 'manual' });
  remember(instanceJar, answer);
  for (;;) {
    const location = answer.headers.get('location');
    if (answer.status < 300 || answer.status >= 400 || !location || location.startsWith('/#')) return { instanceJar, landed: answer };
    const next = new URL(location, answer.url);
    if (next.origin !== root.url && next.origin !== at.url) return { instanceJar, landed: answer };
    const jar = next.origin === root.url ? rootJar : instanceJar;
    answer = await fetch(next, { redirect: 'manual', headers: { cookie: cookieOf(jar) } });
    remember(jar, answer);
  }
}

const after = (): string => new Date(Date.now() + 1000).toISOString();

const whoami = (jar: Jar) => fetch(`${instance.url}/api/whoami`, { headers: { cookie: cookieOf(jar) } });

describe('signing in on an instance through root\'s OpenID provider', () => {
  it('answers as its public address whatever name a request reached it by, so the issuer, every address it hands out and the tokens agree', async () => {
    await signIn.announce();
    const other = 'http://root-alias.test';
    const discovered = await (await fetch(`${other}/oidc/.well-known/openid-configuration`)).json() as Record<string, unknown>;
    expect(discovered.issuer).toBe(`${root.url}/oidc`);
    for (const endpoint of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) expect(String(discovered[endpoint])).toMatch(new RegExp(`^${root.url}/oidc/`));
    const start = await fetch(`${instance.url}/api/auth/oidc/start`, { redirect: 'manual' });
    const authorize = start.headers.get('location')!;
    expect(new URL(authorize).origin).toBe(root.url);
    const reachedElsewhere = await fetch(authorize.replace(root.url, other), { redirect: 'manual' });
    const next = reachedElsewhere.headers.get('location')!;
    expect(next.startsWith('/') || new URL(next).origin === root.url, `root sent a browser that reached it as ${other} to ${next}`).toBe(true);
    const { landed } = await signInAs('u1');
    expect([landed.status, landed.headers.get('location')]).toEqual([302, '/#/chat']);
  });

  it('takes its owner from root\'s session to their instance with the claims root issued, checked there without a call to root', async () => {
    await signIn.announce();
    const { instanceJar, landed } = await signInAs('u1');
    expect([landed.status, landed.headers.get('location')]).toEqual([302, '/#/chat']);
    expect(instanceJar.get('session')).toBeTruthy();
    const me = await whoami(instanceJar);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      id: 'u1',
      claims: [{ role: 'person' }, { role: 'operator' }, { role: 'instance-owner' }],
      permissions: { administer: true, 'manage-accounts': false, 'see-all-work': true, 'open-platform-namespaces': true, 'change-instance-settings': true, 'manage-own-account': false },
    });
    expect(await instanceDb.accounts.getUserById('u1')).toMatchObject({ email: 'u1@example.com', emailVerified: true });
  });

  it('refuses anyone else root has signed in, and takes no sign-in before the instance has named its key', async () => {
    const early = await signInAs('u1');
    expect(early.landed.status).toBeGreaterThanOrEqual(400);
    await signIn.announce();
    const stranger = await signInAs('u2');
    expect(stranger.landed.status).toBe(403);
    expect(await stranger.landed.text()).toMatch(/belongs to someone else/);
    expect(stranger.instanceJar.get('session')).toBeUndefined();
  });

  it('renews stale claims through root with the refresh token it keeps, and the session ends once root has revoked it', async () => {
    await signIn.announce();
    offset = -21 * 60 * 1000;
    const { instanceJar } = await signInAs('u1');
    offset = 0;
    const renewed = await whoami(instanceJar);
    expect(renewed.status).toBe(200);
    remember(instanceJar, renewed);
    expect(renewed.headers.getSetCookie().some((line) => line.startsWith('session='))).toBe(true);

    await provider.revoke({ personId: 'u1', at: after(), because: 'signed-out-everywhere' });
    await provider.deliverLogouts();
    expect(heard).toEqual([having({ personId: 'u1', because: 'signed-out-everywhere' })]);
    expect(await rootDb.instances.pendingLogouts()).toEqual([]);
    expect((await whoami(instanceJar)).status).toBe(401);
    expect(await instanceDb.instances.getRevocations()).toEqual([having({ subject: 'u1' })]);
  });

  it('keeps a revocation root could not deliver and delivers it once the instance answers', async () => {
    await signIn.announce();
    const { instanceJar } = await signInAs('u1');
    instance.up = false;
    await provider.revoke({ personId: 'u1', at: after(), because: 'account-removed' });
    await provider.deliverLogouts();
    const [waiting] = await rootDb.instances.pendingLogouts();
    expect(waiting).toMatchObject({ clientId: 'inst-u1', subject: 'u1', why: 'account-removed', attempts: 1 });
    instance.up = true;
    await provider.deliverLogouts();
    expect(await rootDb.instances.pendingLogouts()).toEqual([]);
    expect((await whoami(instanceJar)).status).toBe(401);
  });

  it('in production sends a logout only where its check for public addresses lets it', async () => {
    await signIn.announce();
    const { instanceJar } = await signInAs('u1');
    const refusing = mock<ReachFetchers>();
    refusing.public.mockRejectedValue(new Error('Koala does not reach that from here: 127.0.0.1 is a private, loopback, mesh or reserved address'));
    const strict = new RootProvider({ issuer: `${root.url}/oidc`, signing: rootSigning, cookieKey: 'cookie-key-for-the-round-trip', proxied: false, reach: new InstanceReach({ open: false, domain: 'koala.dev' }, refusing) }, rootDb);
    await strict.revoke({ personId: 'u1', at: after(), because: 'signed-out-everywhere' });
    await strict.deliverLogouts();
    const [waiting] = await rootDb.instances.pendingLogouts();
    expect(waiting).toMatchObject({ clientId: 'inst-u1', attempts: 1, lastError: matching(/Koala does not reach that from here: 127\.0\.0\.1 is a private, loopback, mesh or reserved address/) });
    expect(heard).toEqual([]);
    expect((await whoami(instanceJar)).status).toBe(200);
  });

  it('gives the instance a short-lived service token root takes in place of its long-lived credential', async () => {
    signIn.keepAnnouncing(() => undefined);
    const token = await signIn.serviceToken();
    expect(await provider.serviceCaller(token)).toEqual({ clientId: 'inst-u1', kind: 'instance' });
    expect(await rootService.ownerOf('inst-u1', token)).toEqual({ ok: true, value: { ownerId: 'u1' } });
    expect(await rootService.ownerOf('inst-other', token)).toMatchObject({ ok: false });
    expect(await rootService.ownerOf('inst-u1', 'not-a-token')).toMatchObject({ ok: false, status: 401 });
    expect(await signIn.serviceToken()).toBe(token);
  });

  it('ends a session signed out of on the instance at once, and drops what would renew it', async () => {
    await signIn.announce();
    const { instanceJar } = await signInAs('u1');
    expect((await whoami(instanceJar)).status).toBe(200);
    const kept = (await signInAs('u1')).instanceJar;
    await instanceAuth.endSession({ headers: { cookie: cookieOf(instanceJar) }, secure: false } as unknown as express.Request);
    expect((await whoami(instanceJar)).status).toBe(401);
    expect((await whoami(kept)).status).toBe(200);
    const ended = signIn.verified(instanceJar.get('session'))!;
    expect(await instanceDb.instances.getClientSession(ended.sid)).toBeUndefined();
    offset = 21 * 60 * 1000;
    expect((await whoami(instanceJar)).status).toBe(401);
  });

  it('names the person the hub signed in to root by a token root gave them there, and not by one an instance holds', async () => {
    await signIn.announce();
    const atInstance = signIn.verified((await signInAs('u1')).instanceJar.get('session'));
    const instanceToken = await signIn.personToken(atInstance);
    expect(instanceToken).toBeTruthy();
    expect(await provider.personAtHub(instanceToken!)).toBeUndefined();
    const atHub = (await signInAs('u2', hub)).instanceJar;
    const onHub = hubSignIn.verified(atHub.get('session'));
    expect(onHub?.userId).toBe('u2');
    const hubToken = await hubSignIn.personToken(onHub);
    expect(await provider.personAtHub(hubToken!)).toBe('u2');
    expect(await provider.personAtHub('made-up')).toBeUndefined();
    await provider.revoke({ personId: 'u2', at: after(), because: 'signed-out-everywhere' });
    expect(await provider.personAtHub(hubToken!)).toBeUndefined();
  });
});

describe('what an instance does when the sign-in does not go through', () => {
  it('refuses a return from root that did not start in this browser', async () => {
    await signIn.announce();
    const nothing = await signIn.callback(new URL(`${instance.url}/api/auth/oidc/callback?code=c&state=s`), undefined);
    expect(nothing).toEqual({ ok: false, status: 400, error: 'this sign-in did not start in this browser — sign in again from here' });
    const started = await signIn.start('/projects');
    const forged = await signIn.callback(new URL(`${instance.url}/api/auth/oidc/callback?code=c&state=another`), started.cookie);
    expect(forged).toMatchObject({ ok: false, status: 401 });
    const garbage = await signIn.callback(new URL(`${instance.url}/api/auth/oidc/callback`), 'not-a-cookie');
    expect(garbage).toMatchObject({ ok: false, status: 400 });
  });

  it('starts a sign-in that keeps only a path of its own in the cookie, with an address back to itself', async () => {
    await signIn.announce();
    expect(signIn.redirectUri).toBe(`${instance.url}/api/auth/oidc/callback`);
    expect(signIn.issuer).toBe(`${root.url}/oidc`);
    expect(signIn.startCookieSeconds).toBe(600);
    expect(signIn.sessionSeconds).toBeGreaterThan(60 * 60);
    const started = await signIn.start('//evil.example.com');
    const url = new URL(started.url);
    expect(url.origin).toBe(root.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('redirect_uri')).toBe(signIn.redirectUri);
  });

  it('reads no one from a session token it did not sign, or one that root has revoked', async () => {
    await signIn.announce();
    expect(signIn.verified(undefined)).toBeUndefined();
    expect(signIn.verified('garbage')).toBeUndefined();
    const { instanceJar } = await signInAs('u1');
    const session = signIn.verified(instanceJar.get('session'));
    expect(session?.userId).toBe('u1');
    await provider.revoke({ personId: 'u1', at: after(), because: 'signed-out-everywhere' });
    await provider.deliverLogouts();
    expect(signIn.verified(instanceJar.get('session'))).toBeUndefined();
  });

  it('takes a logout token only when it is a string root signed for this client and for ending sessions', async () => {
    await signIn.announce();
    expect(await signIn.backchannel(undefined)).toEqual({ ok: false, error: 'send the logout token as logout_token' });
    expect(await signIn.backchannel('garbage')).toMatchObject({ ok: false, error: containing('the logout token could not be checked') });
    const forPerson = await provider.logoutToken({ id: 'd1', clientId: 'inst-u1', url: 'x', subject: 'u1', revokedAt: after(), why: 'member-removed' as never, attempts: 0 } as never);
    expect(await signIn.backchannel(forPerson)).toEqual({ ok: false, error: 'that is not a logout token' });
    const elsewhere = await provider.logoutToken({ id: 'd2', clientId: 'inst-other', url: 'x', subject: 'u1', revokedAt: after(), why: 'signed-out-everywhere', attempts: 0 } as never);
    expect(await signIn.backchannel(elsewhere)).toMatchObject({ ok: false, error: containing('the logout token could not be checked') });
    const good = await provider.logoutToken({ id: 'd3', clientId: 'inst-u1', url: 'x', subject: 'u1', revokedAt: after(), why: 'signed-out-everywhere', attempts: 0 } as never);
    expect(await signIn.backchannel(good)).toEqual({ ok: true });
    expect(heard).toEqual([having({ personId: 'u1' })]);
  });

  it('says root has not taken its key, and tries again until it does', async () => {
    instance.up = true;
    root.up = false;
    const said: string[] = [];
    signIn.keepAnnouncing((message) => said.push(message), 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(said.length).toBeGreaterThanOrEqual(1);
    expect(said[0]).toMatch(/^root has not taken this instance's sign-in key yet: .*; trying again in 0 s$/);
    root.up = true;
    await signIn.announced;
    expect(await rootDb.instances.getInstances('u1')).toEqual([having({ signIn: having({}) })]);
  });

  it('says what root answered when it refuses the key', async () => {
    root.app.put('/api/hub-link/sign-in-key', (_req, res) => { res.status(401).json({ error: 'no' }); });
    await expect(hubSignIn.announce()).rejects.toThrow('root answered 401 to this hub\'s sign-in key');
  });
});

describe('an instance keeping its session with root', () => {
  it('keeps the session as it was while root cannot be reached, and ends it for a session it does not hold', async () => {
    await signIn.announce();
    const { instanceJar } = await signInAs('u1');
    const session = signIn.verified(instanceJar.get('session'))!;
    root.up = false;
    expect(await signIn.renew(session)).toBe('kept');
    root.up = true;
    expect(await signIn.renew({ ...session, sid: 'unknown' })).toBe('ended');
    expect(await signIn.renew({ ...session, userId: 'u2' })).toBe('ended');
    expect(await signIn.personToken(undefined)).toBeUndefined();
  });

  it('asks root once for a session renewed twice at once', async () => {
    await signIn.announce();
    const { instanceJar } = await signInAs('u1');
    const session = signIn.verified(instanceJar.get('session'))!;
    const [first, second] = await Promise.all([signIn.renew(session), signIn.renew(session)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ token: anyText() });
  });

  it('ends the session when root refuses the refresh token, and holds the access token it was given', async () => {
    await signIn.announce();
    const { instanceJar } = await signInAs('u1');
    const session = signIn.verified(instanceJar.get('session'))!;
    expect(await signIn.personToken(session)).toBeTruthy();
    await rootDb.instances.oidcForgetAccount('u1');
    offset = 10 * 60 * 60 * 1000;
    expect(await signIn.personToken(session)).toBeUndefined();
    expect(await instanceDb.instances.getClientSession(session.sid)).toBeUndefined();
  });

  it('ends a session on the instance by dropping it', async () => {
    await signIn.announce();
    const { instanceJar } = await signInAs('u1');
    const session = signIn.verified(instanceJar.get('session'))!;
    await signIn.end(session);
    expect(await instanceDb.instances.getClientSession(session.sid)).toBeUndefined();
  });
});

describe('root sending a logout to the hub', () => {
  it('reaches the hub\'s own address and ends the person\'s sessions there', async () => {
    await signIn.announce();
    hub.app.post('/api/auth/oidc/backchannel-logout', express.urlencoded({ extended: false }), async (req, res) => {
      const outcome = await hubSignIn.backchannel((req.body as { logout_token?: string }).logout_token);
      res.status(outcome.ok ? 200 : 400).json(outcome);
    });
    const atHub = (await signInAs('u2', hub)).instanceJar;
    expect(hubSignIn.verified(atHub.get('session'))?.userId).toBe('u2');
    await provider.revoke({ personId: 'u2', at: after(), because: 'signed-out-everywhere' });
    await provider.deliverLogouts();
    expect(await rootDb.instances.pendingLogouts()).toEqual([]);
    expect(hubSignIn.verified(atHub.get('session'))).toBeUndefined();
  });

  it('ignores a revocation that does not end sessions, and sends nothing for someone who signed in nowhere', async () => {
    await provider.revoke({ personId: 'u2', at: after(), because: 'member-removed', sharedProjectId: 'p1' } as never);
    expect(await rootDb.instances.pendingLogouts()).toEqual([]);
    await rootDb.accounts.saveUser({ id: 'u3', email: 'u3@example.com', emailVerified: true, twoFactorEnabled: false, createdAt: 'x' });
    await provider.revoke({ personId: 'u3', at: after(), because: 'signed-out-everywhere' });
    expect((await rootDb.instances.pendingLogouts()).map((delivery) => delivery.clientId)).toEqual(['hub']);
  });

  it('knows its clients: the hub, an instance it registered, and nobody else', async () => {
    await signIn.announce();
    expect(await provider.registration('hub')).toMatchObject({ clientId: 'hub' });
    expect(await provider.registration('inst-u1')).toMatchObject({ clientId: 'inst-u1' });
    expect(await provider.registration('inst-nobody')).toBeUndefined();
    expect(provider.issuer).toBe(`${root.url}/oidc`);
    expect(provider.proxied).toBe(false);
  });

  it('refuses a service token it did not issue', async () => {
    expect(await provider.serviceCaller('not-a-token')).toBeUndefined();
  });
});
