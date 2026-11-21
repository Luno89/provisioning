import { beforeEach, expect, it } from 'vitest';
import express from 'express';
import { asyncRoute, type Database } from '../../platform/index.js';
import { createAuth, type Auth } from '../../platform/middleware/auth.js';
import { SessionEnds } from '../../platform/services/SessionEnds.js';
import { sessionToken } from '../../platform/lib/auth.js';
import type { AccessRevoked } from '../../platform/lib/revocations.js';
import { sessionView, type Principal } from '../../platform/lib/permissions.js';
import { AccessRevocations } from '../../platform/services/AccessRevocations.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../lib/identity-token.js';
import { claimsFor, clientKeysFrom, runResourceOf } from '../lib/oidc.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { RootProvider } from '../services/RootProvider.js';
import type { InstanceReach } from '../services/InstanceReach.js';
import { RootSignIn } from '../services/RootSignIn.js';
import { InstanceService, hashCredential } from '../services/InstanceService.js';
import { oidcProviderRouter } from '../routes/oidc-provider.js';
import { signInRouter } from '../routes/sign-in.js';
import { IdentityService } from '../services/IdentityService.js';
import { openRoutesOf } from '../../open-routes.js';

export const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);
export const having = (fields: Record<string, unknown>): unknown => expect.objectContaining(fields);

const rootSigning = identityKeysFrom(generateIdentityKey());
const ROOT_SESSION = 'root-session-key-for-the-round-trip';
const INSTANCE_SESSION = 'instance-session-key-for-the-round-trip';
const DATA_KEY = 'instance-data-key-for-the-round-trip-0001';

export type Jar = Map<string, string>;

export const remember = (jar: Jar, answer: Response): void => {
  for (const line of answer.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const at = pair!.indexOf('=');
    const name = pair!.slice(0, at);
    const value = pair!.slice(at + 1);
    if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
};

export const cookieOf = (jar: Jar): string => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

export interface Served { url: string; app: express.Express }

export interface SignInWorldOptions<S extends Served> {
  databases: { root: () => Promise<Database>; instance: () => Promise<Database> };
  serve: (name: 'root' | 'instance') => Promise<S>;
  reach: () => InstanceReach;
  alias: (root: S) => string;
  revokedAt: () => string;
  goDown: (served: S) => Promise<void>;
  comeBack: (served: S) => Promise<void>;
}

export interface SignInWorld<S extends Served> {
  readonly root: S;
  readonly instance: S;
  readonly rootDb: Database;
  readonly instanceDb: Database;
  readonly provider: RootProvider;
  readonly signIn: RootSignIn;
  readonly instanceAuth: Auth;
  readonly rootService: InstanceService;
  readonly heard: readonly AccessRevoked[];
  readonly alias: string;
  offset: number;
  signInAs(userId: string, at?: S): Promise<{ instanceJar: Jar; landed: Response }>;
  whoami(jar: Jar): Promise<Response>;
  revokedAt(): string;
  goDown(served: S): Promise<void>;
  comeBack(served: S): Promise<void>;
}

export function rootSignInWorld<S extends Served>(options: SignInWorldOptions<S>): SignInWorld<S> {
  let rootDb: Database;
  let instanceDb: Database;
  let root: S;
  let instance: S;
  let provider: RootProvider;
  let signIn: RootSignIn;
  let instanceAuth: Auth;
  let rootService: InstanceService;
  let offset = 0;
  const heard: AccessRevoked[] = [];

  beforeEach(async () => {
    rootDb = await options.databases.root();
    instanceDb = await options.databases.instance();
    root = await options.serve('root');
    instance = await options.serve('instance');
    offset = 0;
    heard.length = 0;

    await rootDb.accounts.saveUser({ id: 'u1', email: 'u1@example.com', emailVerified: true, twoFactorEnabled: false, createdAt: '2026-10-29T00:00:00.000Z' });
    await rootDb.accounts.saveUser({ id: 'u2', email: 'u2@example.com', emailVerified: true, twoFactorEnabled: false, createdAt: '2026-10-29T00:00:00.000Z' });
    await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: instance.url, credentialHash: hashCredential('the-instance-credential'), createdAt: 'x', updatedAt: 'x', status: 'ready' });

    provider = new RootProvider({ issuer: `${root.url}/oidc`, signing: rootSigning, cookieKey: 'cookie-key-for-the-round-trip', proxied: false, reach: options.reach() }, rootDb);
    rootService = new InstanceService(rootDb, { rootUrl: root.url, rootPublicKeys: () => [], registry: '', imageTag: 'dev', serviceCaller: (token) => provider.serviceCaller(token) }, undefined);
    const rootAuth = createAuth({ db: rootDb, sessionKey: ROOT_SESSION, publicUrl: root.url, role: 'root', open: openRoutesOf('root'), sessionEnds: new SessionEnds(rootDb.platform) });
    root.app.use('/oidc', oidcProviderRouter({ provider, signedIn: (req) => rootAuth.userFromSessionCookie(req.headers.cookie, false) }));
    root.app.put('/api/instances/sign-in-key', express.json(), asyncRoute(async (req, res) => {
      const outcome = await rootService.announceSignIn(req.headers['x-instance-id'], String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), ((req.body ?? {}) as { jwk?: unknown }).jwk);
      if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
      return res.json(outcome.value);
    }));

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
    instanceAuth = createAuth({ db: instanceDb, sessionKey: INSTANCE_SESSION, publicUrl: instance.url, role: 'instance', open: openRoutesOf('instance'), instanceOwnerId: 'u1', clientSessions: signIn, sessionEnds: new SessionEnds(instanceDb.platform) });
    const identity = new IdentityService({ role: 'instance', trusted: trustedKeys([publicKeyPem(rootSigning.publicKey)]), instance: { id: 'inst-u1', ownerId: 'u1', rootUrl: root.url } }, instanceDb);
    instance.app.use('/api/auth', signInRouter({ signIn, identity, auth: instanceAuth, publicUrl: instance.url, landing: '/chat' }));
    instance.app.use('/api', instanceAuth.requireAuth);
    instance.app.get('/api/whoami', (req, res) => {
      const signed = req as unknown as { user: { id: string; email: string }; principal: Principal };
      const { id, claims, permissions } = sessionView(signed.user, signed.principal, { holdsAccounts: false });
      res.json({ id, claims, permissions });
    });

  });

  async function signInAs(userId: string, at: S = instance): Promise<{ instanceJar: Jar; landed: Response }> {
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

  const whoami = (jar: Jar) => fetch(`${instance.url}/api/whoami`, { headers: { cookie: cookieOf(jar) } });

  return {
    get root() { return root; },
    get instance() { return instance; },
    get rootDb() { return rootDb; },
    get instanceDb() { return instanceDb; },
    get provider() { return provider; },
    get signIn() { return signIn; },
    get instanceAuth() { return instanceAuth; },
    get rootService() { return rootService; },
    get alias() { return options.alias(root); },
    get offset() { return offset; },
    set offset(next: number) { offset = next; },
    heard,
    signInAs,
    whoami,
    revokedAt: options.revokedAt,
    goDown: options.goDown,
    comeBack: options.comeBack,
  };
}

export function signingInThroughRoot<S extends Served>(world: SignInWorld<S>): void {
  it('answers as its public address whatever name a request reached it by, so the issuer, every address it hands out and the tokens agree', async () => {
    await world.signIn.announce();
    const other = world.alias;
    const discovered = await (await fetch(`${other}/oidc/.well-known/openid-configuration`)).json() as Record<string, unknown>;
    expect(discovered.issuer).toBe(`${world.root.url}/oidc`);
    for (const endpoint of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) expect(String(discovered[endpoint])).toMatch(new RegExp(`^${world.root.url}/oidc/`));
    const start = await fetch(`${world.instance.url}/api/auth/oidc/start`, { redirect: 'manual' });
    const authorize = start.headers.get('location')!;
    expect(new URL(authorize).origin).toBe(world.root.url);
    const reachedElsewhere = await fetch(authorize.replace(world.root.url, other), { redirect: 'manual' });
    const next = reachedElsewhere.headers.get('location')!;
    expect(next.startsWith('/') || new URL(next).origin === world.root.url, `root sent a browser that reached it as ${other} to ${next}`).toBe(true);
    const { landed } = await world.signInAs('u1');
    expect([landed.status, landed.headers.get('location')]).toEqual([302, '/#/chat']);
  });

  it('takes its owner from root\'s session to their instance with the claims root issued, checked there without a call to root', async () => {
    await world.signIn.announce();
    const { instanceJar, landed } = await world.signInAs('u1');
    expect([landed.status, landed.headers.get('location')]).toEqual([302, '/#/chat']);
    expect(instanceJar.get('session')).toBeTruthy();
    const me = await world.whoami(instanceJar);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      id: 'u1',
      claims: [{ role: 'person' }, { role: 'operator' }, { role: 'instance-owner' }],
      permissions: { administer: true, 'manage-accounts': false, 'see-all-work': true, 'open-platform-namespaces': true, 'change-instance-settings': true, 'manage-own-account': false, 'set-up-again': true },
    });
    expect(await world.instanceDb.accounts.getUserById('u1')).toMatchObject({ email: 'u1@example.com', emailVerified: true });
  });

  it('refuses anyone else root has signed in, and takes no sign-in before the instance has named its key', async () => {
    const early = await world.signInAs('u1');
    expect(early.landed.status).toBeGreaterThanOrEqual(400);
    await world.signIn.announce();
    const stranger = await world.signInAs('u2');
    expect(stranger.landed.status).toBe(403);
    expect(await stranger.landed.text()).toMatch(/belongs to someone else/);
    expect(stranger.instanceJar.get('session')).toBeUndefined();
  });

  it('renews stale claims through root with the refresh token it keeps, and the session ends once root has revoked it', async () => {
    await world.signIn.announce();
    world.offset = -21 * 60 * 1000;
    const { instanceJar } = await world.signInAs('u1');
    world.offset = 0;
    const renewed = await world.whoami(instanceJar);
    expect(renewed.status).toBe(200);
    remember(instanceJar, renewed);
    expect(renewed.headers.getSetCookie().some((line) => line.startsWith('session='))).toBe(true);

    await world.provider.revoke({ personId: 'u1', at: world.revokedAt(), because: 'signed-out-everywhere' });
    await world.provider.deliverLogouts();
    expect(world.heard).toEqual([having({ personId: 'u1', because: 'signed-out-everywhere' })]);
    expect(await world.rootDb.instances.pendingLogouts()).toEqual([]);
    expect((await world.whoami(instanceJar)).status).toBe(401);
    expect(await world.instanceDb.instances.getRevocations()).toEqual([having({ subject: 'u1' })]);
  });

  it('keeps a revocation root could not deliver and delivers it once the instance answers', async () => {
    await world.signIn.announce();
    const { instanceJar } = await world.signInAs('u1');
    await world.goDown(world.instance);
    await world.provider.revoke({ personId: 'u1', at: world.revokedAt(), because: 'account-removed' });
    await world.provider.deliverLogouts();
    const [waiting] = await world.rootDb.instances.pendingLogouts();
    expect(waiting).toMatchObject({ clientId: 'inst-u1', subject: 'u1', why: 'account-removed', attempts: 1 });
    await world.comeBack(world.instance);
    await world.provider.deliverLogouts();
    expect(await world.rootDb.instances.pendingLogouts()).toEqual([]);
    expect((await world.whoami(instanceJar)).status).toBe(401);
  });
}

export function sessionsThroughRoot<S extends Served>(world: SignInWorld<S>): void {
  it('gives the instance a short-lived service token root takes in place of its long-lived credential', async () => {
    world.signIn.keepAnnouncing(() => undefined);
    const token = await world.signIn.serviceToken();
    expect(await world.provider.serviceCaller(token)).toEqual({ clientId: 'inst-u1', kind: 'instance' });
    expect(await world.rootService.ownerOf('inst-u1', token)).toEqual({ ok: true, value: { ownerId: 'u1' } });
    expect(await world.rootService.ownerOf('inst-other', token)).toMatchObject({ ok: false });
    expect(await world.rootService.ownerOf('inst-u1', 'not-a-token')).toMatchObject({ ok: false, status: 401 });
    expect(await world.signIn.serviceToken()).toBe(token);
  });

  it('ends a session signed out of on the instance at once, and drops what would renew it', async () => {
    await world.signIn.announce();
    const { instanceJar } = await world.signInAs('u1');
    expect((await world.whoami(instanceJar)).status).toBe(200);
    const kept = (await world.signInAs('u1')).instanceJar;
    await world.instanceAuth.endSession({ headers: { cookie: cookieOf(instanceJar) }, secure: false } as unknown as express.Request);
    expect((await world.whoami(instanceJar)).status).toBe(401);
    expect((await world.whoami(kept)).status).toBe(200);
    const ended = world.signIn.verified(instanceJar.get('session'))!;
    expect(await world.instanceDb.instances.getClientSession(ended.sid)).toBeUndefined();
    world.offset = 21 * 60 * 1000;
    expect((await world.whoami(instanceJar)).status).toBe(401);
  });

}

export async function logoutKeptFromAPrivateAddress<S extends Served>(world: SignInWorld<S>, reach: InstanceReach): Promise<void> {
  await world.signIn.announce();
  const { instanceJar } = await world.signInAs('u1');
  const strict = new RootProvider({ issuer: `${world.root.url}/oidc`, signing: rootSigning, cookieKey: 'cookie-key-for-the-round-trip', proxied: false, reach }, world.rootDb);
  await strict.revoke({ personId: 'u1', at: world.revokedAt(), because: 'signed-out-everywhere' });
  await strict.deliverLogouts();
  const [waiting] = await world.rootDb.instances.pendingLogouts();
  expect(waiting).toMatchObject({ clientId: 'inst-u1', attempts: 1, lastError: matching(/Koala does not reach that from here: 127\.0\.0\.1 is a private, loopback, mesh or reserved address/) });
  expect(world.heard).toEqual([]);
  expect((await world.whoami(instanceJar)).status).toBe(200);
}

export function runTokensThroughRoot<S extends Served>(world: SignInWorld<S>): void {
  const runTokenOf = async (accessToken: string) => (await jwtVerify(accessToken, createRemoteJWKSet(new URL(`${world.root.url}/oidc/jwks`)), {
    issuer: `${world.root.url}/oidc`, audience: runResourceOf('inst-u1'), typ: 'at+jwt',
  })).payload;

  it('gives a run of its owner a token of its own for this instance, stamped with their claims as the run started, through every renewal', async () => {
    await world.signIn.announce();
    await world.signInAs('u1');
    const owner = (await world.rootDb.accounts.getUserById('u1'))!;
    const atStart = claimsFor(owner, { kind: 'instance', owner: 'u1' });

    const run = await world.signIn.runToken('run-1');
    expect(await runTokenOf(run.accessToken)).toMatchObject({ sub: 'u1', koala_run: 'run-1', act: { sub: 'inst-u1' }, koala_claims: atStart });

    await world.rootDb.accounts.saveUser({ ...owner, space: { person: 'u2' } } as never);
    expect(claimsFor((await world.rootDb.accounts.getUserById('u1'))!, { kind: 'instance', owner: 'u1' })).not.toEqual(atStart);
    const renewed = await world.signIn.renewRunToken(run.refreshToken);
    expect(renewed.refreshToken).not.toBe(run.refreshToken);
    expect(await runTokenOf(renewed.accessToken)).toMatchObject({ sub: 'u1', koala_run: 'run-1', koala_claims: atStart });
  });

  it('names the check space a run token was asked for, through every renewal, and names none when none was asked for', async () => {
    await world.signIn.announce();
    await world.signInAs('u1');
    const inSpace = await world.signIn.runToken('check-1', 'space-a');
    expect(await runTokenOf(inSpace.accessToken)).toMatchObject({ sub: 'u1', koala_run: 'check-1', koala_space: 'space-a' });
    expect(await runTokenOf((await world.signIn.renewRunToken(inSpace.refreshToken)).accessToken)).toMatchObject({ koala_run: 'check-1', koala_space: 'space-a' });
    expect(await runTokenOf((await world.signIn.runToken('run-1')).accessToken)).not.toHaveProperty('koala_space');
  });

  it('gives no run token for a person not signed in to this instance, none once they sign out everywhere, and none for a run that ended', async () => {
    await world.signIn.announce();
    await expect(world.signIn.runToken('run-1')).rejects.toThrow(/not signed in to this Koala/);

    await world.signInAs('u1');
    const ended = await world.signIn.runToken('run-ended');
    await world.signIn.endRunToken(ended.refreshToken);
    await expect(world.signIn.renewRunToken(ended.refreshToken)).rejects.toThrow();

    const live = await world.signIn.runToken('run-live');
    await world.provider.revoke({ personId: 'u1', at: world.revokedAt(), because: 'signed-out-everywhere' });
    await expect(world.signIn.renewRunToken(live.refreshToken)).rejects.toThrow();
    await expect(world.signIn.runToken('run-after')).rejects.toThrow(/not signed in to this Koala/);
  });
}
