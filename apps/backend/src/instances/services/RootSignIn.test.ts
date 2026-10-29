import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { createAuth } from '../../platform/middleware/auth.js';
import { sessionToken } from '../../platform/lib/auth.js';
import { AccessRevocations, type AccessRevoked } from '../../platform/lib/access-revocation.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../lib/identity-token.js';
import { clientKeysFrom } from '../lib/oidc.js';
import { RootProvider } from './RootProvider.js';
import { RootSignIn } from './RootSignIn.js';
import { InstanceService, hashCredential } from './InstanceService.js';
import { oidcProviderRouter } from '../routes/oidc-provider.js';
import { signInRouter } from '../routes/sign-in.js';
import { IdentityService } from './IdentityService.js';

const rootSigning = identityKeysFrom(generateIdentityKey());
const ROOT_SESSION = 'root-session-key-for-the-round-trip';
const INSTANCE_SESSION = 'instance-session-key-for-the-round-trip';
const DATA_KEY = 'instance-data-key-for-the-round-trip-0001';

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

interface Served { url: string; server: http.Server; app: express.Express }

async function serve(): Promise<Served> {
  const app = express();
  const server = http.createServer((req, res) => app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, app };
}

let rootDb: MongoDB;
let instanceDb: MongoDB;
let root: Served;
let instance: Served;
let provider: RootProvider;
let signIn: RootSignIn;
let rootService: InstanceService;
let offset: number;
const heard: AccessRevoked[] = [];

beforeEach(async () => {
  rootDb = await testDatabase();
  instanceDb = await testDatabase();
  root = await serve();
  instance = await serve();
  offset = 0;
  heard.length = 0;

  await rootDb.accounts.saveUser({ id: 'u1', email: 'u1@example.com', emailVerified: true, twoFactorEnabled: false, createdAt: '2026-10-29T00:00:00.000Z' });
  await rootDb.accounts.saveUser({ id: 'u2', email: 'u2@example.com', emailVerified: true, twoFactorEnabled: false, createdAt: '2026-10-29T00:00:00.000Z' });
  await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: instance.url, credentialHash: hashCredential('the-instance-credential'), createdAt: 'x', updatedAt: 'x', status: 'ready' });

  provider = new RootProvider({ issuer: `${root.url}/oidc`, signing: rootSigning, cookieKey: 'cookie-key-for-the-round-trip', proxied: false }, rootDb);
  rootService = new InstanceService(rootDb, { rootUrl: root.url, rootPublicKeys: () => [], registry: '', imageTag: 'dev', serviceCaller: (token) => provider.serviceCaller(token) }, undefined);
  const rootAuth = createAuth({ db: rootDb, sessionKey: ROOT_SESSION, publicUrl: root.url, role: 'root' });
  root.app.use('/oidc', oidcProviderRouter({ provider, signedIn: (req) => rootAuth.userFromSessionCookie(req.headers.cookie, false) }));
  root.app.put('/api/instances/sign-in-key', express.json(), async (req, res) => {
    const outcome = await rootService.announceSignIn(req.headers['x-instance-id'], String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), req.body?.jwk);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  });

  const revocations = new AccessRevocations();
  revocations.on((event) => { heard.push(event); });
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
  const instanceAuth = createAuth({ db: instanceDb, sessionKey: INSTANCE_SESSION, publicUrl: instance.url, role: 'instance', instanceOwnerId: 'u1', clientSessions: signIn });
  const identity = new IdentityService({ role: 'instance', trusted: trustedKeys([publicKeyPem(rootSigning.publicKey)]), instance: { id: 'inst-u1', ownerId: 'u1', rootUrl: root.url } }, instanceDb);
  instance.app.use('/api/auth', signInRouter({ signIn, identity, auth: instanceAuth, publicUrl: instance.url, landing: '/chat' }));
  instance.app.use('/api', instanceAuth.requireAuth);
  instance.app.get('/api/whoami', (req, res) => {
    const signed = req as unknown as { user: { id: string }; principal: { claims: unknown[] } };
    res.json({ id: signed.user.id, claims: signed.principal.claims });
  });
});

afterEach(async () => {
  await new Promise((resolve) => root.server.close(resolve));
  await new Promise((resolve) => instance.server.close(resolve));
});

async function signInAs(userId: string): Promise<{ instanceJar: Jar; landed: Response }> {
  const rootJar: Jar = new Map([['session', sessionToken({ id: userId, email: `${userId}@example.com` }, ROOT_SESSION)]]);
  const instanceJar: Jar = new Map();
  let answer = await fetch(`${instance.url}/api/auth/oidc/start`, { redirect: 'manual' });
  remember(instanceJar, answer);
  for (;;) {
    const location = answer.headers.get('location');
    if (answer.status < 300 || answer.status >= 400 || !location || location.startsWith('/#')) return { instanceJar, landed: answer };
    const next = new URL(location, answer.url);
    if (next.origin !== root.url && next.origin !== instance.url) return { instanceJar, landed: answer };
    const jar = next.origin === root.url ? rootJar : instanceJar;
    answer = await fetch(next, { redirect: 'manual', headers: { cookie: cookieOf(jar) } });
    remember(jar, answer);
  }
}

const whoami = (jar: Jar) => fetch(`${instance.url}/api/whoami`, { headers: { cookie: cookieOf(jar) } });

describe('signing in on an instance through root\'s OpenID provider', () => {
  it('takes its owner from root\'s session to their instance with the claims root issued, checked there without a call to root', async () => {
    await signIn.announce();
    const { instanceJar, landed } = await signInAs('u1');
    expect([landed.status, landed.headers.get('location')]).toEqual([302, '/#/chat']);
    expect(instanceJar.get('session')).toBeTruthy();
    const me = await whoami(instanceJar);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ id: 'u1', claims: [{ role: 'person' }, { role: 'operator' }, { role: 'instance-owner' }] });
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

    await provider.revoke({ subject: 'u1', at: new Date().toISOString(), why: 'signed-out-everywhere' });
    await provider.deliverLogouts();
    expect(heard).toEqual([expect.objectContaining({ subject: 'u1', why: 'signed-out-everywhere' })]);
    expect(await rootDb.instances.pendingLogouts()).toEqual([]);
    expect((await whoami(instanceJar)).status).toBe(401);
    expect(await instanceDb.instances.getRevocations()).toEqual([expect.objectContaining({ subject: 'u1' })]);
  });

  it('keeps a revocation root could not deliver and delivers it once the instance answers', async () => {
    await signIn.announce();
    const { instanceJar } = await signInAs('u1');
    await new Promise((resolve) => instance.server.close(resolve));
    await provider.revoke({ subject: 'u1', at: new Date().toISOString(), why: 'account-removed' });
    await provider.deliverLogouts();
    const [waiting] = await rootDb.instances.pendingLogouts();
    expect(waiting).toMatchObject({ clientId: 'inst-u1', subject: 'u1', why: 'account-removed', attempts: 1 });
    await new Promise<void>((resolve) => instance.server.listen(Number(new URL(instance.url).port), '127.0.0.1', resolve));
    await provider.deliverLogouts();
    expect(await rootDb.instances.pendingLogouts()).toEqual([]);
    expect((await whoami(instanceJar)).status).toBe(401);
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
});
