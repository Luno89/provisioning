import { beforeEach, expect, it } from 'vitest';
import { asyncRoute, type Database } from '../../platform/index.js';
import type { Auth } from '../../platform/middleware/auth.js';
import type { BrowserPerson } from '../../platform/lib/browser-session.js';
import type { DependencyId } from '../../platform/lib/dependencies.js';
import type { AccessRevoked } from '../../platform/lib/revocations.js';
import { sessionView, type Principal } from '../../platform/lib/permissions.js';
import { AccessRevocations } from '../../platform/services/AccessRevocations.js';
import { claimsFor, clientMetadata, publicJwkOf, runResourceOf, SERVICE_TOKEN_SECONDS } from '../lib/oidc.js';
import { generateIdentityKey, identityKeysFrom, type IdentityKeyPair } from '../lib/identity-token.js';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { clientKeysFrom, clientPublicJwkOf, MACHINE_REGISTRATION_REFUSED, MACHINE_SCOPE, machineRegistration, newClientKey, OidcClient, type ClientKeys } from '@koala/engine-core/root-client';
import { RootProvider } from '../services/RootProvider.js';
import type { InstanceReach } from '../services/InstanceReach.js';
import type { RootSignIn } from '../services/RootSignIn.js';
import { grantsOver } from '../../engine/testing/run-grants.js';
import { rootWebFor } from './root-web.js';
import type { InstanceService } from '../services/InstanceService.js';
import {
  SESSION_ID_COOKIE, cookieOf, remember, rootSigning, servedThroughRoot, sessionIdOf, signInThroughRoot, type Jar, type Served, type ThroughRoot,
} from './through-root.js';

const whoCalls = (caller: { clientId: string; kind: string; until: number } | undefined): { clientId: string; kind: string } | undefined => {
  if (!caller) return undefined;
  const { until: _until, ...who } = caller;
  return who;
};

export const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);
export const having = (fields: Record<string, unknown>): unknown => expect.objectContaining(fields);

export const signedByRoot = (claims: Record<string, unknown>, typ: string): Promise<string> =>
  new SignJWT(claims).setProtectedHeader({ alg: 'Ed25519', typ, kid: rootSigning.kid }).sign(rootSigning.privateKey);

export { SESSION_ID_COOKIE, cookieOf, remember, sessionIdOf, type Jar, type Served };

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
  readonly clientKeys: IdentityKeyPair;
  readonly registrationCode: string;
  readonly heard: readonly AccessRevoked[];
  readonly rootDown: ReadonlyArray<{ dependency: DependencyId; reason: string }>;
  heldPerson(jar: Jar): Promise<BrowserPerson | undefined>;
  signOut(jar: Jar): Promise<Response>;
  breakRevocations(why: string | undefined): void;
  readonly alias: string;
  offset: number;
  signInAs(userId: string, at?: S, rootJar?: Jar): Promise<{ instanceJar: Jar; rootJar: Jar; landed: Response }>;
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
  let clientKeys: IdentityKeyPair;
  let registrationCode: string;
  let signInAtRoot: ThroughRoot['signInAtRoot'];
  let offset = 0;
  const heard: AccessRevoked[] = [];
  const rootDown: Array<{ dependency: DependencyId; reason: string }> = [];
  let broken: string | undefined;

  beforeEach(async () => {
    rootDb = await options.databases.root();
    instanceDb = await options.databases.instance();
    root = await options.serve('root');
    instance = await options.serve('instance');
    offset = 0;
    heard.length = 0;
    rootDown.length = 0;
    broken = undefined;

    await rootDb.accounts.saveUser({ id: 'u1', email: 'u1@example.com', emailVerified: true, twoFactorEnabled: false, createdAt: '2026-10-29T00:00:00.000Z' });
    await rootDb.accounts.saveUser({ id: 'u2', email: 'u2@example.com', emailVerified: true, twoFactorEnabled: false, createdAt: '2026-10-29T00:00:00.000Z' });
    const revocations = new AccessRevocations();
    revocations.listen(async (event) => { heard.push(event); });
    revocations.listen(async () => { if (broken) throw new Error(broken); });
    const runGrants = grantsOver(instanceDb.engine);
    revocations.listen(async (event) => { await runGrants.revokeGrantsOf(event); });
    ({ provider, rootService, signIn, instanceAuth, clientKeys, registrationCode, signInAtRoot } = await servedThroughRoot({
      rootDb, instanceDb, root, instance, reach: options.reach(), instanceId: 'inst-u1', ownerId: 'u1', revocations,
      dependency: { failed: (dependency, err) => { rootDown.push({ dependency, reason: (err as Error).message }); return err; } },
      now: () => Date.now() + offset,
    }));
    instance.app.use('/api', instanceAuth.requireAuth);
    instance.app.post('/api/sign-out', asyncRoute(async (req, res) => {
      res.json({ endSession: await instanceAuth.endSession(req) ?? null });
    }));
    instance.app.get('/api/whoami', (req, res) => {
      const signed = req as unknown as { user: { id: string; email: string }; principal: Principal };
      const { id, claims, permissions } = sessionView(signed.user, signed.principal, { holdsAccounts: false });
      res.json({ id, claims, permissions });
    });

  });

  async function signInAs(userId: string, at: S = instance, given?: Jar): Promise<{ instanceJar: Jar; rootJar: Jar; landed: Response }> {
    const rootJar = given ?? await signInAtRoot({ id: userId, email: `${userId}@example.com` });
    const { instanceJar, landed } = await signInThroughRoot(root.url, at.url, rootJar);
    return { instanceJar, rootJar, landed };
  }

  const whoami = (jar: Jar) => fetch(`${instance.url}/api/whoami`, { headers: { cookie: cookieOf(jar) } });

  const heldPerson = async (jar: Jar): Promise<BrowserPerson | undefined> => {
    const sid = sessionIdOf(jar);
    if (!sid) return undefined;
    return new Promise((resolve, reject) => {
      instanceDb.platform.browserSessions().get(sid, (err, held) => (err ? reject(err as Error) : resolve(held?.person)));
    });
  };

  const signOut = async (jar: Jar): Promise<Response> => {
    const answer = await fetch(`${instance.url}/api/sign-out`, { method: 'POST', headers: { cookie: cookieOf(jar) } });
    remember(jar, answer);
    return answer;
  };

  return {
    get root() { return root; },
    get instance() { return instance; },
    get rootDb() { return rootDb; },
    get instanceDb() { return instanceDb; },
    get provider() { return provider; },
    get signIn() { return signIn; },
    get instanceAuth() { return instanceAuth; },
    get rootService() { return rootService; },
    get clientKeys() { return clientKeys; },
    get registrationCode() { return registrationCode; },
    get alias() { return options.alias(root); },
    get offset() { return offset; },
    set offset(next: number) { offset = next; },
    heard,
    rootDown,
    heldPerson,
    signOut,
    breakRevocations: (why) => { broken = why; },
    signInAs,
    whoami,
    revokedAt: options.revokedAt,
    goDown: options.goDown,
    comeBack: options.comeBack,
  };
}

export function signingInThroughRoot<S extends Served>(world: SignInWorld<S>): void {
  const registering = (code: string, key: IdentityKeyPair) => fetch(`${world.root.url}/oidc/reg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${code}` },
    body: JSON.stringify({ ...clientMetadata({ clientId: 'ignored', kind: 'instance', url: world.instance.url, key: publicJwkOf(key) }), client_id: undefined }),
  });

  it('registers the instance at root with the one-use code root gave it, keeping only the public half of the key the instance made, and refuses the code a second time', async () => {
    expect(await world.rootDb.instances.getInstances('u1')).toEqual([having({ id: 'inst-u1' })]);
    expect((await world.rootDb.instances.getInstances('u1'))[0]?.signIn).toBeUndefined();
    await world.signIn.register();
    await world.signIn.register();
    const [registered] = await world.rootDb.instances.getInstances('u1');
    expect(registered?.signIn?.jwk).toEqual(publicJwkOf(world.clientKeys));
    expect(JSON.stringify(registered)).not.toContain(String((world.clientKeys.privateKey.export({ format: 'jwk' }) as { d?: string }).d));
    const another = identityKeysFrom(generateIdentityKey());
    const again = await registering(world.registrationCode, another);
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: 'invalid_token' });
    expect((await world.rootDb.instances.getInstances('u1'))[0]?.signIn?.jwk).toEqual(publicJwkOf(world.clientKeys));
    expect(whoCalls(await world.provider.serviceCaller(await world.signIn.serviceToken()))).toEqual({ clientId: 'inst-u1', kind: 'instance' });
  });

  const refusalOf = (err: Error & { error?: unknown }): unknown => err.error ?? err.message;

  const stillInstalling = async (): Promise<{ followed: Promise<'held'> }> => {
    const store = world.rootDb.instances;
    const [placed] = await store.getInstances('u1');
    await store.saveInstance({ ...placed!, url: '', status: 'installing', install: { id: 'install-1', machineId: 'desk', state: 'installing', at: 'x' } });
    const follow = store.followInstance.bind(store);
    const followed = new Promise<'held'>((resolve) => {
      store.followInstance = (id, on) => {
        const watching = follow(id, on);
        void watching.ready.then(() => resolve('held'));
        return watching;
      };
    });
    return { followed };
  };

  it('holds the token requests of an instance that has registered until its install tells root its address, then answers them, never calling its code used', async () => {
    const { followed } = await stillInstalling();
    await world.signIn.register();
    const again = world.signIn.register().then(() => 'registered', (err: Error) => err.message);
    expect(await Promise.race([followed, again])).toBe('held');
    await world.rootDb.instances.updateInstall('inst-u1', 'install-1', { url: world.instance.url, 'install.state': 'ready', status: 'ready' });
    expect(await again).toBe('registered');
    expect(whoCalls(await world.provider.serviceCaller(await world.signIn.serviceToken()))).toEqual({ clientId: 'inst-u1', kind: 'instance' });
  });

  it('ends a held token request with a refusal once the install ends without an address, or the instance is removed', async () => {
    const { followed } = await stillInstalling();
    await world.signIn.register();
    const failing = world.signIn.serviceToken().then(() => 'answered', refusalOf);
    expect(await Promise.race([followed, failing])).toBe('held');
    await world.rootDb.instances.updateInstall('inst-u1', 'install-1', { 'install.state': 'failed', status: 'failed' });
    expect(await failing).toBe('invalid_client');
    const removal = await stillInstalling();
    const removed = world.signIn.serviceToken().then(() => 'answered', refusalOf);
    expect(await Promise.race([removal.followed, removed])).toBe('held');
    await world.rootDb.instances.deleteInstance('inst-u1');
    expect(await removed).toBe('invalid_client');
  });

  it('takes a newer code in place of an older one, and registers the key of whoever holds the newer code as the instance', async () => {
    const newer = await world.provider.registrationCode({ id: 'inst-u1', ownerId: 'u1' });
    const stale = await registering(world.registrationCode, world.clientKeys);
    expect(stale.status).toBe(401);
    const another = identityKeysFrom(generateIdentityKey());
    const taken = await registering(newer, another);
    expect(taken.status).toBe(201);
    expect(await taken.json()).toMatchObject({ client_id: 'inst-u1', koala_owner: 'u1', token_endpoint_auth_method: 'private_key_jwt' });
    expect((await world.rootDb.instances.getInstances('u1'))[0]?.signIn?.jwk).toEqual(publicJwkOf(another));
  });

  it('refuses a registration without a code root made, and one whose key is not a single Ed25519 key, without using the code up', async () => {
    expect((await registering('not-a-code', world.clientKeys)).status).toBe(401);
    const twoKeys = await fetch(`${world.root.url}/oidc/reg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${world.registrationCode}` },
      body: JSON.stringify({ ...clientMetadata({ clientId: 'ignored', kind: 'instance', url: world.instance.url, key: publicJwkOf(world.clientKeys) }), client_id: undefined, jwks: { keys: [] } }),
    });
    expect(twoKeys.status).toBe(400);
    await world.signIn.register();
    expect((await world.rootDb.instances.getInstances('u1'))[0]?.signIn?.jwk).toEqual(publicJwkOf(world.clientKeys));
  });

  const machineAt = (code: string, keys: ClientKeys): OidcClient => new OidcClient({
    clientId: 'desk-1', issuer: `${world.root.url}/oidc`, keys, registrationCode: code,
    registration: machineRegistration(clientPublicJwkOf(keys)), refused: MACHINE_REGISTRATION_REFUSED, scope: MACHINE_SCOPE,
  });

  it('registers a machine at root with the one-use code its join gave it, as a client of its owner that takes only its own tokens, and refuses the code a second time and the machine once it is removed', async () => {
    await world.rootDb.machines.saveLocalAgentDevice({ id: 'desk-1', ownerId: 'u1', name: 'desk', rootDir: '/home/u1/koala', createdAt: '2026-11-21T00:00:00.000Z' });
    const code = await world.provider.machineRegistrationCode({ id: 'desk-1', ownerId: 'u1' });
    const keys = clientKeysFrom(newClientKey());
    const machine = machineAt(code, keys);
    await machine.register();
    const [device] = await world.rootDb.machines.getLocalAgentDevices();
    expect(device?.signIn).toEqual({ jwk: clientPublicJwkOf(keys), since: matching(/^\d{4}-/) });
    expect(JSON.stringify(device)).not.toContain(String((keys.privateKey.export({ format: 'jwk' }) as { d?: string }).d));
    expect(await world.provider.serviceCaller(await machine.token())).toBeUndefined();
    await expect(machineAt(code, clientKeysFrom(newClientKey())).register()).rejects.toThrow(MACHINE_REGISTRATION_REFUSED);
    expect(await world.rootDb.instances.oidcTakeRegistration(world.registrationCode)).toEqual({ kind: 'instance', id: 'inst-u1' });
    await world.rootDb.machines.deleteLocalAgentDevice('desk-1');
    await expect(machineAt(code, keys).token()).rejects.toMatchObject({ error: 'invalid_client' });
  });

  it('answers as its public address whatever name a request reached it by, so the issuer, every address it hands out and the tokens agree', async () => {
    await world.signIn.register();
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
    await world.signIn.register();
    const { instanceJar, landed } = await world.signInAs('u1');
    expect([landed.status, landed.headers.get('location')]).toEqual([302, '/#/chat']);
    expect([...instanceJar.keys()]).toEqual([SESSION_ID_COOKIE]);
    expect(await world.heldPerson(instanceJar)).toMatchObject({ sub: 'u1', email: 'u1@example.com', claims: [{ role: 'person' }, { role: 'operator' }, { role: 'instance-owner' }] });
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
    await world.signIn.register();
    const stranger = await world.signInAs('u2');
    expect(stranger.landed.status).toBe(403);
    expect(await stranger.landed.text()).toMatch(/belongs to someone else/);
    expect(await world.heldPerson(stranger.instanceJar)).toBeUndefined();
    expect((await world.whoami(stranger.instanceJar)).status).toBe(401);
  });

  it('renews the tokens it holds through root once they run out, as the same session, and the session ends once root has revoked it', async () => {
    await world.signIn.register();
    const { instanceJar } = await world.signInAs('u1');
    const before = (await world.heldPerson(instanceJar))!;
    world.offset = before.accessExp - Date.now() + 1000;
    const renewed = await world.whoami(instanceJar);
    expect(renewed.status).toBe(200);
    remember(instanceJar, renewed);
    const after = (await world.heldPerson(instanceJar))!;
    expect(after.accessExp).toBeGreaterThan(before.accessExp);
    expect(after.tokens.refresh).not.toBe(before.tokens.refresh);
    expect([after.sub, after.sessionAt]).toEqual([before.sub, before.sessionAt]);

    await world.provider.revoke({ personId: 'u1', at: world.revokedAt(), because: 'signed-out-everywhere' });
    await world.provider.deliverLogouts();
    expect(world.heard).toEqual([having({ personId: 'u1', because: 'signed-out-everywhere' })]);
    expect(await world.rootDb.instances.pendingLogouts()).toEqual([]);
    expect(await world.heldPerson(instanceJar)).toBeUndefined();
    expect((await world.whoami(instanceJar)).status).toBe(401);
  });

  it('keeps a signed-in browser on its last claims while root cannot be reached, says root is down, and lets root decide once it answers', async () => {
    await world.signIn.register();
    const { instanceJar } = await world.signInAs('u1');
    const before = (await world.heldPerson(instanceJar))!;
    world.offset = before.accessExp - Date.now() + 1000;
    await world.goDown(world.root);
    const meanwhile = await world.whoami(instanceJar);
    expect(meanwhile.status).toBe(200);
    expect(await meanwhile.json()).toMatchObject({ id: 'u1', claims: before.claims });
    expect(world.rootDown).toEqual([having({ dependency: 'root' })]);
    expect((await world.heldPerson(instanceJar))!.accessExp).toBe(before.accessExp);
    await world.comeBack(world.root);
    await world.rootDb.instances.oidcForgetAccount('u1');
    expect((await world.whoami(instanceJar)).status).toBe(401);
    expect(await world.heldPerson(instanceJar)).toBeUndefined();
  });

  it('keeps a revocation root could not deliver and delivers it once the instance answers', async () => {
    await world.signIn.register();
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
    world.signIn.keepRegistering(() => undefined);
    const asked = Date.now();
    const token = await world.signIn.serviceToken();
    const caller = await world.provider.serviceCaller(token);
    expect(whoCalls(caller)).toEqual({ clientId: 'inst-u1', kind: 'instance' });
    expect(caller!.until).toBeGreaterThan(asked);
    expect(caller!.until).toBeLessThanOrEqual(Date.now() + SERVICE_TOKEN_SECONDS * 1000 + 1000);
    expect(await world.rootService.ownerOf('inst-u1', token)).toEqual({ ok: true, value: { ownerId: 'u1' } });
    expect(await world.rootService.ownerOf('inst-other', token)).toMatchObject({ ok: false });
    expect(await world.rootService.ownerOf('inst-u1', 'not-a-token')).toMatchObject({ ok: false, status: 401 });
    expect(await world.rootService.ownerOf('inst-u1', world.registrationCode)).toMatchObject({ ok: false, status: 401 });
    expect(await world.signIn.serviceToken()).toBe(token);
  });

  it('takes no one from no cookie, or from a cookie it never made', async () => {
    await world.signIn.register();
    expect((await world.whoami(new Map())).status).toBe(401);
    expect((await world.whoami(new Map([[SESSION_ID_COOKIE, 's%3Anever-made.signature']]))).status).toBe(401);
  });

  it('makes each sign-in a session of its own, kept under the same id through every renewal', async () => {
    await world.signIn.register();
    const first = (await world.signInAs('u1')).instanceJar;
    const second = (await world.signInAs('u1')).instanceJar;
    expect(sessionIdOf(second)).not.toBe(sessionIdOf(first));
    const held = (await world.heldPerson(first))!;
    const id = sessionIdOf(first);
    world.offset = held.accessExp - Date.now() + 1000;
    const renewed = await world.whoami(first);
    remember(first, renewed);
    expect(renewed.status).toBe(200);
    expect(sessionIdOf(first)).toBe(id);
    expect((await world.heldPerson(first))!.accessExp).toBeGreaterThan(held.accessExp);
  });

  it('ends a session signed out of on the instance at once, hands its refresh token back to root and sends the browser to end root\'s session too', async () => {
    await world.signIn.register();
    const { instanceJar } = await world.signInAs('u1');
    const kept = (await world.signInAs('u1')).instanceJar;
    const held = (await world.heldPerson(instanceJar))!;
    const signedOut = await world.signOut(instanceJar);
    const { endSession } = await signedOut.json() as { endSession: string };
    expect((await world.whoami(instanceJar)).status).toBe(401);
    expect(await world.heldPerson(instanceJar)).toBeUndefined();
    expect((await world.whoami(kept)).status).toBe(200);
    const ending = new URL(endSession);
    expect(`${ending.origin}${ending.pathname}`).toBe(`${world.root.url}/oidc/session/end`);
    expect(ending.searchParams.get('post_logout_redirect_uri')).toBe(`${world.instance.url}/`);
    expect(ending.searchParams.get('id_token_hint')).toBeTruthy();
    world.offset = held.accessExp - Date.now() + 1000;
    expect(await world.signIn.fresh(held)).toBe('ended');
  });

  it('ends root\'s session in that browser once the person confirms, and root\'s logout ends every session here that came from it', async () => {
    await world.signIn.register();
    const { instanceJar, rootJar } = await world.signInAs('u1');
    const again = (await world.signInAs('u1', world.instance, rootJar)).instanceJar;
    const elsewhere = (await world.signInAs('u1')).instanceJar;
    const { endSession } = await (await world.signOut(instanceJar)).json() as { endSession: string };
    const asked = await fetch(endSession, { headers: { cookie: cookieOf(rootJar) }, redirect: 'manual' });
    remember(rootJar, asked);
    const page = await asked.text();
    const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1];
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(page)?.[1];
    expect([asked.status, Boolean(action), Boolean(xsrf)]).toEqual([200, true, true]);
    const confirmed = await fetch(new URL(action!.replace(/&amp;/g, '&'), world.root.url), {
      method: 'POST', redirect: 'manual', headers: { cookie: cookieOf(rootJar), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ xsrf: xsrf!, logout: 'yes' }),
    });
    expect([confirmed.status, confirmed.headers.get('location')]).toEqual([303, `${world.instance.url}/`]);
    expect((await world.whoami(again)).status).toBe(401);
    expect((await world.whoami(elsewhere)).status).toBe(200);
  });

}

export async function logoutKeptFromAPrivateAddress<S extends Served>(world: SignInWorld<S>, reach: InstanceReach): Promise<void> {
  await world.signIn.register();
  const { instanceJar } = await world.signInAs('u1');
  const strict = new RootProvider({ issuer: `${world.root.url}/oidc`, signing: rootSigning, cookieKey: 'cookie-key-for-the-round-trip', proxied: false, reach, web: rootWebFor(world.root.url) }, world.rootDb);
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
    await world.signIn.register();
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
    await world.signIn.register();
    await world.signInAs('u1');
    const inSpace = await world.signIn.runToken('check-1', 'space-a');
    expect(await runTokenOf(inSpace.accessToken)).toMatchObject({ sub: 'u1', koala_run: 'check-1', koala_space: 'space-a' });
    expect(await runTokenOf((await world.signIn.renewRunToken(inSpace.refreshToken)).accessToken)).toMatchObject({ koala_run: 'check-1', koala_space: 'space-a' });
    expect(await runTokenOf((await world.signIn.runToken('run-1')).accessToken)).not.toHaveProperty('koala_space');
  });

  it('gives no run token for a person not signed in to this instance, none once they sign out everywhere, and none for a run that ended', async () => {
    await world.signIn.register();
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

export function runBearersThroughRoot<S extends Served>(world: SignInWorld<S>): void {
  const liveGrant = (runId: string, principal: Principal = { kind: 'person', id: 'u1', claims: [{ role: 'person' }] }) =>
    world.instanceDb.engine.saveRunGrant({ id: `grant-${runId}`, ownerId: principal.id, personId: principal.id, runId, principal, scope: {}, startedBy: 'person', state: 'live', issuedAt: new Date().toISOString() });
  const asBearer = (token: string, cookie?: string) => fetch(`${world.instance.url}/api/whoami`, { headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) } });

  it('takes a run\'s token on this instance as the run\'s person with the claims they had as it started, only while the run\'s grant is live here', async () => {
    await world.signIn.register();
    await world.signInAs('u1');
    await liveGrant('run-1');
    const run = await world.signIn.runToken('run-1');
    const me = await asBearer(run.accessToken);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: 'u1', claims: claimsFor((await world.rootDb.accounts.getUserById('u1'))!, { kind: 'instance', owner: 'u1' }) });

    await world.instanceDb.engine.saveRunGrant({ ...(await world.instanceDb.engine.getRunGrantOfRun('run-1'))!, state: 'ended' });
    const after = await asBearer(run.accessToken);
    expect([after.status, (await after.json() as { error: string }).error]).toEqual([401, 'Unauthorized: run run-1 has ended']);
    const unknown = await asBearer((await world.signIn.runToken('run-never')).accessToken);
    expect([unknown.status, (await unknown.json() as { error: string }).error]).toEqual([401, 'Unauthorized: run run-never is not known here']);
  });

  it('refuses a run\'s token once root takes its person\'s access away, as soon as the logout lands', async () => {
    await world.signIn.register();
    await world.signInAs('u1');
    await liveGrant('run-1');
    const run = await world.signIn.runToken('run-1');
    expect((await asBearer(run.accessToken)).status).toBe(200);
    await world.provider.revoke({ personId: 'u1', at: world.revokedAt(), because: 'signed-out-everywhere' });
    await world.provider.deliverLogouts();
    const after = await asBearer(run.accessToken);
    expect([after.status, (await after.json() as { error: string }).error]).toEqual([401, 'Unauthorized: run run-1\'s access was taken away']);
  });

  it('refuses a token root did not sign, one for another audience, and one that is not an access token, and never reads the cookie beside a bearer', async () => {
    await world.signIn.register();
    const { instanceJar } = await world.signInAs('u1');
    await liveGrant('run-1');
    const claims = { sub: 'u1', koala_run: 'run-1', koala_claims: [{ role: 'person' }] };
    const signed = (over: { aud?: string; typ?: string; key?: typeof rootSigning }) => new SignJWT(claims)
      .setProtectedHeader({ alg: 'Ed25519', typ: over.typ ?? 'at+jwt', kid: (over.key ?? rootSigning).kid })
      .setIssuer(`${world.root.url}/oidc`).setAudience(over.aud ?? runResourceOf('inst-u1')).setIssuedAt().setExpirationTime('5m')
      .sign((over.key ?? rootSigning).privateKey);
    const refusedFor = async (token: string, cookie?: string) => {
      const answer = await asBearer(token, cookie);
      return [answer.status, (await answer.json() as { error: string }).error];
    };
    expect(await refusedFor(await signed({}))).toEqual([200, undefined]);
    expect(await refusedFor(await signed({ key: identityKeysFrom(generateIdentityKey()) }))).toEqual([401, matching(/^Unauthorized: the run token could not be checked/)]);
    expect(await refusedFor(await signed({ aud: runResourceOf('inst-u2') }))).toEqual([401, matching(/^Unauthorized: the run token could not be checked: .*aud/)]);
    expect(await refusedFor(await signed({ typ: 'JWT' }))).toEqual([401, matching(/^Unauthorized: the run token could not be checked: .*typ/)]);
    expect(await refusedFor('not-a-token', cookieOf(instanceJar))).toEqual([401, matching(/^Unauthorized: the run token could not be checked/)]);
  });

  it('acts as a check space a run token names only when the space is the token\'s person\'s', async () => {
    await world.signIn.register();
    await world.signInAs('u1');
    await liveGrant('check-1');
    const space = (id: string, person: string) => world.instanceDb.accounts.saveUser({ id, email: `${id}@spaces.koala`, emailVerified: true, twoFactorEnabled: false, createdAt: '2026-11-21T00:00:00.000Z', space: { person } } as never);
    await space('space-a', 'u1');
    await space('space-x', 'u2');
    const mine = await asBearer((await world.signIn.runToken('check-1', 'space-a')).accessToken);
    expect(await mine.json()).toMatchObject({ id: 'space-a', claims: [{ role: 'person' }, { role: 'space-of', person: 'u1' }] });
    const theirs = await asBearer((await world.signIn.runToken('check-1', 'space-x')).accessToken);
    expect([theirs.status, (await theirs.json() as { error: string }).error]).toEqual([401, 'Unauthorized: space-x is not a check space of this run\'s person']);
    const gone = await asBearer((await world.signIn.runToken('check-1', 'space-gone')).accessToken);
    expect([gone.status, (await gone.json() as { error: string }).error]).toEqual([401, 'Unauthorized: space-gone is not a check space of this run\'s person']);
  });
}
