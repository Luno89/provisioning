import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { http, HttpResponse } from 'msw';
import { mock } from 'vitest-mock-extended';
import { reopening } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { serveInProcess } from '../testing/serve-in-process.js';
import { InstanceReach, type ReachFetchers } from './InstanceReach.js';
import { rootSignInWorld, signingInThroughRoot, sessionsThroughRoot, logoutKeptFromAPrivateAddress, having, type Served } from '../testing/root-sign-in-behaviour.js';

const containing = (text: string): unknown => expect.stringContaining(text);
const anyText = (): unknown => expect.any(String);

interface Answering extends Served { up: boolean }

const sameWorld = (): ReachFetchers => {
  const fetchers = mock<ReachFetchers>();
  fetchers.open.mockImplementation(((url: string | URL | Request, init?: RequestInit) => fetch(url, init)) as never);
  return fetchers;
};

const after = (): string => new Date(Date.now() + 1000).toISOString();

const world = rootSignInWorld<Answering>({
  databases: { root: async () => memoryDatabase(), instance: async () => memoryDatabase(), hub: async () => memoryDatabase() },
  serve: async (name) => ({ url: `http://${name}.test`, app: express(), up: true }),
  reach: () => new InstanceReach({ open: true }, sameWorld()),
  alias: () => 'http://root-alias.test',
  revokedAt: after,
  goDown: async (served) => { served.up = false; },
  comeBack: async (served) => { served.up = true; },
});

const answerFor = (place: () => Answering) => ({ request }: { request: Request }) => {
  const served = place();
  return served.up ? serveInProcess(served.app, request) : HttpResponse.error();
};

interceptHttp(
  http.all('http://root.test/*', answerFor(() => world.root)),
  http.all('http://root-alias.test/*', answerFor(() => world.root)),
  http.all('http://instance.test/*', answerFor(() => world.instance)),
  http.all('http://hub.test/*', answerFor(() => world.hub)),
);

describe('signing in on an instance through root\'s OpenID provider', () => {
  signingInThroughRoot(world);

  it('keeps delivering a revocation on its own, waiting longer each time, until the instance answers', async () => {
    await world.signIn.announce();
    const { instanceJar } = await world.signInAs('u1');
    world.instance.up = false;
    world.provider.keepDelivering(reopening(20));
    await world.provider.revoke({ personId: 'u1', at: after(), because: 'account-removed' });
    await vi.waitFor(async () => expect((await world.rootDb.instances.pendingLogouts())[0]?.attempts).toBeGreaterThanOrEqual(2));
    world.instance.up = true;
    await vi.waitFor(async () => expect(await world.rootDb.instances.pendingLogouts()).toEqual([]), { timeout: 5_000 });
    expect((await world.whoami(instanceJar)).status).toBe(401);
    world.provider.stopDelivering();
  });

  it('in production sends a logout only where its check for public addresses lets it', async () => {
    const refusing = mock<ReachFetchers>();
    refusing.public.mockRejectedValue(new Error('Koala does not reach that from here: 127.0.0.1 is a private, loopback, mesh or reserved address'));
    await logoutKeptFromAPrivateAddress(world, new InstanceReach({ open: false, domain: 'koala.dev' }, refusing));
  });

  sessionsThroughRoot(world);
});

describe('what an instance does when the sign-in does not go through', () => {
  it('refuses a return from root that did not start in this browser', async () => {
    await world.signIn.announce();
    const nothing = await world.signIn.callback(new URL(`${world.instance.url}/api/auth/oidc/callback?code=c&state=s`), undefined);
    expect(nothing).toEqual({ ok: false, status: 400, error: 'this sign-in did not start in this browser — sign in again from here' });
    const started = await world.signIn.start('/projects');
    const forged = await world.signIn.callback(new URL(`${world.instance.url}/api/auth/oidc/callback?code=c&state=another`), started.cookie);
    expect(forged).toMatchObject({ ok: false, status: 401 });
    const garbage = await world.signIn.callback(new URL(`${world.instance.url}/api/auth/oidc/callback`), 'not-a-cookie');
    expect(garbage).toMatchObject({ ok: false, status: 400 });
  });

  it('starts a sign-in that keeps only a path of its own in the cookie, with an address back to itself', async () => {
    await world.signIn.announce();
    expect(world.signIn.redirectUri).toBe(`${world.instance.url}/api/auth/oidc/callback`);
    expect(world.signIn.issuer).toBe(`${world.root.url}/oidc`);
    expect(world.signIn.startCookieSeconds).toBe(600);
    expect(world.signIn.sessionSeconds).toBeGreaterThan(60 * 60);
    const started = await world.signIn.start('//evil.example.com');
    const url = new URL(started.url);
    expect(url.origin).toBe(world.root.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('redirect_uri')).toBe(world.signIn.redirectUri);
  });

  it('reads no one from a session token it did not sign, or one that root has revoked', async () => {
    await world.signIn.announce();
    expect(world.signIn.verified(undefined)).toBeUndefined();
    expect(world.signIn.verified('garbage')).toBeUndefined();
    const { instanceJar } = await world.signInAs('u1');
    const session = world.signIn.verified(instanceJar.get('session'));
    expect(session?.userId).toBe('u1');
    await world.provider.revoke({ personId: 'u1', at: after(), because: 'signed-out-everywhere' });
    await world.provider.deliverLogouts();
    expect(world.signIn.verified(instanceJar.get('session'))).toBeUndefined();
  });

  it('takes a logout token only when it is a string root signed for this client and for ending sessions', async () => {
    await world.signIn.announce();
    expect(await world.signIn.backchannel(undefined)).toEqual({ ok: false, error: 'send the logout token as logout_token' });
    expect(await world.signIn.backchannel('garbage')).toMatchObject({ ok: false, error: containing('the logout token could not be checked') });
    const forPerson = await world.provider.logoutToken({ id: 'd1', clientId: 'inst-u1', url: 'x', subject: 'u1', revokedAt: after(), why: 'member-removed' as never, attempts: 0 } as never);
    expect(await world.signIn.backchannel(forPerson)).toEqual({ ok: false, error: 'that is not a logout token' });
    const elsewhere = await world.provider.logoutToken({ id: 'd2', clientId: 'inst-other', url: 'x', subject: 'u1', revokedAt: after(), why: 'signed-out-everywhere', attempts: 0 } as never);
    expect(await world.signIn.backchannel(elsewhere)).toMatchObject({ ok: false, error: containing('the logout token could not be checked') });
    const good = await world.provider.logoutToken({ id: 'd3', clientId: 'inst-u1', url: 'x', subject: 'u1', revokedAt: after(), why: 'signed-out-everywhere', attempts: 0 } as never);
    expect(await world.signIn.backchannel(good)).toEqual({ ok: true });
    expect(world.heard).toEqual([having({ personId: 'u1' })]);
  });

  it('says root has not taken its key, and tries again until it does', async () => {
    world.instance.up = true;
    world.root.up = false;
    const said: string[] = [];
    let first!: () => void;
    const saidOnce = new Promise<void>((done) => { first = done; });
    world.signIn.keepAnnouncing((message) => { said.push(message); first(); }, reopening(5));
    await saidOnce;
    expect(said.length).toBeGreaterThanOrEqual(1);
    expect(said[0]).toMatch(/^root has not taken this instance's sign-in key yet: .*; trying again in 0 s$/);
    world.root.up = true;
    await world.signIn.announced;
    expect(await world.rootDb.instances.getInstances('u1')).toEqual([having({ signIn: having({}) })]);
  });

  it('says what root answered when it refuses the key', async () => {
    world.root.app.put('/api/hub-link/sign-in-key', (_req, res) => { res.status(401).json({ error: 'no' }); });
    await expect(world.hubSignIn.announce()).rejects.toThrow('root answered 401 to this hub\'s sign-in key');
  });
});

describe('an instance keeping its session with root', () => {
  it('keeps the session as it was while root cannot be reached, and ends it for a session it does not hold', async () => {
    await world.signIn.announce();
    const { instanceJar } = await world.signInAs('u1');
    const session = world.signIn.verified(instanceJar.get('session'))!;
    world.root.up = false;
    expect(await world.signIn.renew(session)).toBe('kept');
    world.root.up = true;
    expect(await world.signIn.renew({ ...session, sid: 'unknown' })).toBe('ended');
    expect(await world.signIn.renew({ ...session, userId: 'u2' })).toBe('ended');
    expect(await world.signIn.personToken(undefined)).toBeUndefined();
  });

  it("takes a session the instance made for one of its own processes, with the instance's claims, never renews it through root, and ends it when root revokes the person", async () => {
    await world.signIn.announce();
    const token = world.signIn.madeHere({ id: 'u1', email: 'u1@example.com' }, [{ role: 'person' }, { role: 'instance-owner' }], 60 * 60);
    const session = world.signIn.verified(token)!;
    expect(session).toEqual(having({ userId: 'u1', madeBy: 'instance', claims: [{ role: 'person' }, { role: 'instance-owner' }] }));
    expect((await world.whoami(new Map([['session', token]]))).status).toBe(200);
    expect(await world.signIn.renew({ ...session, freshUntil: 0 })).toBe('kept');

    await world.provider.revoke({ personId: 'u1', at: after(), because: 'signed-out-everywhere' });
    await world.provider.deliverLogouts();
    expect(world.signIn.verified(token)).toBeUndefined();
    expect((await world.whoami(new Map([['session', token]]))).status).toBe(401);
  });

  it('asks root once for a session renewed twice at once', async () => {
    await world.signIn.announce();
    const { instanceJar } = await world.signInAs('u1');
    const session = world.signIn.verified(instanceJar.get('session'))!;
    const [first, second] = await Promise.all([world.signIn.renew(session), world.signIn.renew(session)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ token: anyText() });
  });

  it('ends the session when root refuses the refresh token, and holds the access token it was given', async () => {
    await world.signIn.announce();
    const { instanceJar } = await world.signInAs('u1');
    const session = world.signIn.verified(instanceJar.get('session'))!;
    expect(await world.signIn.personToken(session)).toBeTruthy();
    await world.rootDb.instances.oidcForgetAccount('u1');
    world.offset = 10 * 60 * 60 * 1000;
    expect(await world.signIn.personToken(session)).toBeUndefined();
    expect(await world.instanceDb.instances.getClientSession(session.sid)).toBeUndefined();
  });

  it('ends a session on the instance by dropping it', async () => {
    await world.signIn.announce();
    const { instanceJar } = await world.signInAs('u1');
    const session = world.signIn.verified(instanceJar.get('session'))!;
    await world.signIn.end(session);
    expect(await world.instanceDb.instances.getClientSession(session.sid)).toBeUndefined();
  });
});

describe('root sending a logout to the hub', () => {
  it('reaches the hub\'s own address and ends the person\'s sessions there', async () => {
    await world.signIn.announce();
    world.hub.app.post('/api/auth/oidc/backchannel-logout', express.urlencoded({ extended: false }), async (req, res) => {
      const outcome = await world.hubSignIn.backchannel((req.body as { logout_token?: string }).logout_token);
      res.status(outcome.ok ? 200 : 400).json(outcome);
    });
    const atHub = (await world.signInAs('u2', world.hub)).instanceJar;
    expect(world.hubSignIn.verified(atHub.get('session'))?.userId).toBe('u2');
    await world.provider.revoke({ personId: 'u2', at: after(), because: 'signed-out-everywhere' });
    await world.provider.deliverLogouts();
    expect(await world.rootDb.instances.pendingLogouts()).toEqual([]);
    expect(world.hubSignIn.verified(atHub.get('session'))).toBeUndefined();
  });

  it('ignores a revocation that does not end sessions, and sends nothing for someone who signed in nowhere', async () => {
    await world.provider.revoke({ personId: 'u2', at: after(), because: 'member-removed', sharedProjectId: 'p1' } as never);
    expect(await world.rootDb.instances.pendingLogouts()).toEqual([]);
    await world.rootDb.accounts.saveUser({ id: 'u3', email: 'u3@example.com', emailVerified: true, twoFactorEnabled: false, createdAt: 'x' });
    await world.provider.revoke({ personId: 'u3', at: after(), because: 'signed-out-everywhere' });
    expect((await world.rootDb.instances.pendingLogouts()).map((delivery) => delivery.clientId)).toEqual(['hub']);
  });

  it('knows its clients: the hub, an instance it registered, and nobody else', async () => {
    await world.signIn.announce();
    expect(await world.provider.registration('hub')).toMatchObject({ clientId: 'hub' });
    expect(await world.provider.registration('inst-u1')).toMatchObject({ clientId: 'inst-u1' });
    expect(await world.provider.registration('inst-nobody')).toBeUndefined();
    expect(world.provider.issuer).toBe(`${world.root.url}/oidc`);
    expect(world.provider.proxied).toBe(false);
  });

  it('refuses a service token it did not issue', async () => {
    expect(await world.provider.serviceCaller('not-a-token')).toBeUndefined();
  });
});
