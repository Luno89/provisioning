import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { http, HttpResponse } from 'msw';
import { mock } from 'vitest-mock-extended';
import { encryptValue, reopening } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { serveInProcess } from '../testing/serve-in-process.js';
import { InstanceReach, type ReachFetchers } from './InstanceReach.js';
import { rootSignInWorld, signingInThroughRoot, sessionsThroughRoot, logoutKeptFromAPrivateAddress, having, signedByRoot, type Served } from '../testing/root-sign-in-behaviour.js';

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
  databases: { root: async () => memoryDatabase(), instance: async () => memoryDatabase() },
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
);

describe('signing in on an instance through root\'s OpenID provider', () => {
  signingInThroughRoot(world);

  it('keeps delivering a revocation on its own, waiting longer each time, until the instance answers', async () => {
    await world.signIn.register();
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
    await world.signIn.register();
    const nothing = await world.signIn.callback(new URL(`${world.instance.url}/api/auth/oidc/callback?code=c&state=s`), undefined);
    expect(nothing).toEqual({ ok: false, status: 400, error: 'this sign-in did not start in this browser — sign in again from here' });
    const started = await world.signIn.start('/projects');
    expect(started.started.next).toBe('/projects');
    const forged = await world.signIn.callback(new URL(`${world.instance.url}/api/auth/oidc/callback?code=c&state=another`), started.started);
    expect(forged).toMatchObject({ ok: false, status: 401 });
    const partial = await world.signIn.callback(new URL(`${world.instance.url}/api/auth/oidc/callback`), { state: 's' } as never);
    expect(partial).toMatchObject({ ok: false, status: 400 });
  });

  it('starts a sign-in that keeps only a path of its own to go back to, with an address back to itself', async () => {
    await world.signIn.register();
    expect(world.signIn.redirectUri).toBe(`${world.instance.url}/api/auth/oidc/callback`);
    expect(world.signIn.issuer).toBe(`${world.root.url}/oidc`);
    const started = await world.signIn.start('//evil.example.com');
    expect(started.started.next).toBeUndefined();
    const url = new URL(started.url);
    expect(url.origin).toBe(world.root.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('redirect_uri')).toBe(world.signIn.redirectUri);
  });

  it('holds no one for a session root has revoked', async () => {
    await world.signIn.register();
    const { instanceJar } = await world.signInAs('u1');
    expect((await world.heldPerson(instanceJar))?.sub).toBe('u1');
    await world.provider.revoke({ personId: 'u1', at: after(), because: 'signed-out-everywhere' });
    await world.provider.deliverLogouts();
    expect(await world.heldPerson(instanceJar)).toBeUndefined();
  });

  it('takes a logout token only when it is a string root signed for this client and for ending sessions', async () => {
    await world.signIn.register();
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

  it('takes each logout token once and only with its expiry, and answers only once everything the person held here was revoked', async () => {
    await world.signIn.register();
    const delivery = (id: string) => ({ id, clientId: 'inst-u1', url: 'x', subject: 'u1', revokedAt: after(), why: 'signed-out-everywhere', attempts: 0 }) as never;
    const once = await world.provider.logoutToken(delivery('d1'));
    expect(await world.signIn.backchannel(once)).toEqual({ ok: true });
    expect(await world.signIn.backchannel(once)).toEqual({ ok: false, error: 'that logout token was already taken' });

    const now = Math.floor(Date.now() / 1000);
    const lasting = await signedByRoot({ iss: world.signIn.issuer, aud: 'inst-u1', sub: 'u1', iat: now, jti: 'no-expiry', events: { 'http://schemas.openid.net/event/backchannel-logout': {} }, koala_revoked_at: after(), koala_why: 'signed-out-everywhere' }, 'logout+jwt');
    expect(await world.signIn.backchannel(lasting)).toMatchObject({ ok: false, error: containing('the logout token could not be checked: missing required "exp" claim') });

    world.breakRevocations('the run grants could not be read');
    expect(await world.signIn.backchannel(await world.provider.logoutToken(delivery('d2')))).toEqual({ ok: false, error: 'not everything u1 held here could be revoked yet: the run grants could not be read' });
    world.breakRevocations(undefined);
    expect(await world.signIn.backchannel(await world.provider.logoutToken(delivery('d3')))).toEqual({ ok: true });
  });

  it('says root has not registered it yet, and tries again until it has', async () => {
    world.instance.up = true;
    world.root.up = false;
    const said: string[] = [];
    let first!: () => void;
    const saidOnce = new Promise<void>((done) => { first = done; });
    world.signIn.keepRegistering((message) => { said.push(message); first(); }, reopening(5));
    await saidOnce;
    expect(said.length).toBeGreaterThanOrEqual(1);
    expect(said[0]).toMatch(/^root has not registered this instance yet: .*; trying again in 0 s$/);
    world.root.up = true;
    await world.signIn.registered;
    expect(await world.rootDb.instances.getInstances('u1')).toEqual([having({ signIn: having({}) })]);
  });

  it('says what to do when root knows neither its key nor its code', async () => {
    await world.rootDb.instances.oidcTakeRegistration(world.registrationCode);
    await expect(world.signIn.register()).rejects.toThrow('root refused this instance\'s registration code (it was used, or a newer one replaced it), and does not know its key: put Koala on your machine again');
  });
});

describe('an instance keeping its session with root', () => {
  const heldOnceItsAccessRunsOut = async () => {
    await world.signIn.register();
    const { instanceJar } = await world.signInAs('u1');
    const person = (await world.heldPerson(instanceJar))!;
    world.offset = person.accessExp - Date.now() + 1000;
    return person;
  };

  it('keeps the person as they were while their tokens are still good, and asks root nothing', async () => {
    await world.signIn.register();
    const { instanceJar } = await world.signInAs('u1');
    const person = (await world.heldPerson(instanceJar))!;
    world.root.up = false;
    expect(await world.signIn.fresh(person)).toBe(person);
    expect(world.rootDown).toEqual([]);
  });

  it('keeps the person on their last claims while root cannot be reached, says root is down, and ends a person whose refresh token root never gave', async () => {
    const person = await heldOnceItsAccessRunsOut();
    world.root.up = false;
    expect(await world.signIn.fresh(person)).toBe('kept');
    expect(world.rootDown).toEqual([having({ dependency: 'root', reason: anyText() })]);
    world.root.up = true;
    expect(await world.signIn.fresh({ ...person, tokens: { ...person.tokens, refresh: encryptValue('never-issued', 'instance-data-key-for-the-round-trip-0001') } })).toBe('ended');
  });

  it('asks root once for a person renewed twice at once', async () => {
    const person = await heldOnceItsAccessRunsOut();
    const [first, second] = await Promise.all([world.signIn.fresh(person), world.signIn.fresh(person)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ sub: 'u1', tokens: { refresh: anyText() } });
  });

  it('ends the person when root refuses the refresh token', async () => {
    await world.signIn.register();
    const { instanceJar } = await world.signInAs('u1');
    const person = (await world.heldPerson(instanceJar))!;
    await world.rootDb.instances.oidcForgetAccount('u1');
    world.offset = 10 * 60 * 60 * 1000;
    expect(await world.signIn.fresh(person)).toBe('ended');
  });
});

describe('root sending logouts', () => {

  it('sends nothing for someone who signed in nowhere', async () => {
    await world.rootDb.accounts.saveUser({ id: 'u3', email: 'u3@example.com', emailVerified: true, twoFactorEnabled: false, createdAt: 'x' });
    await world.provider.revoke({ personId: 'u3', at: after(), because: 'signed-out-everywhere' });
    expect(await world.rootDb.instances.pendingLogouts()).toEqual([]);
  });

  it('knows its clients: an instance it registered, and nobody else', async () => {
    await world.signIn.register();
    expect(await world.provider.registration('hub')).toBeUndefined();
    expect(await world.provider.registration('inst-u1')).toMatchObject({ clientId: 'inst-u1' });
    expect(await world.provider.registration('inst-nobody')).toBeUndefined();
    expect(world.provider.issuer).toBe(`${world.root.url}/oidc`);
    expect(world.provider.proxied).toBe(false);
  });

  it('refuses a service token it did not issue', async () => {
    expect(await world.provider.serviceCaller('not-a-token')).toBeUndefined();
  });
});
