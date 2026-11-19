import { leaseMongo } from '../platform/lib/mongo-lease.js';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { fetchSide, followSignIn, handOff, sessionFrom, signedInLanding, type Side } from '../platform/testing/handoff.js';
import { startThreeRoles, until, waiting, type ThreeRoles } from '../platform/testing/three-roles.js';
import { providerCallbackUrl } from '../accounts/lib/sign-in-providers.js';
import { startStandInIssuer, type StandInIssuer } from '../accounts/testing/stand-in-issuer.js';
import type { LoopbackRole } from '../platform/testing/roles-on-loopback.js';
import type { SmtpSink } from '../platform/testing/smtp-sink.js';

interface Answer { status: number; location: string; body: unknown }

async function call(url: string, init: { method?: string; body?: unknown; cookie?: string | undefined; headers?: Record<string, string> } = {}): Promise<Answer> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.cookie ? { Cookie: init.cookie } : {}), ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text) as unknown; } catch { body = text; }
  return { status: response.status, location: response.headers.get('location') ?? '', body };
}

const STAMP = Date.now().toString(36);
let roles: ThreeRoles;
let issuer: StandInIssuer;
let root: LoopbackRole;
let instance: LoopbackRole;
let hub: LoopbackRole;
let mail: SmtpSink;
let owner: ThreeRoles['owner'];
let instanceId: string;
let mongoUri: string;
let databases: ThreeRoles['databases'];

const mailTo = (subject: RegExp) => until(`a mail with a subject matching ${subject}`, async () => mail.received.find((message) => subject.test(mail.subjectOf(message) ?? '')) ?? waiting(`${mail.received.length} mails received, subjects: ${mail.received.map((message) => mail.subjectOf(message)).join(' | ').slice(0, 200)}`));

async function signedInThrough(from: Side, target: Side, first: string): Promise<{ session: string; callback: string; startCookie: string }> {
  const handed = await handOff(from, target, first);
  expect(signedInLanding(handed.exchange), `the sign-in did not land: ${handed.exchange.status} ${handed.exchange.body.slice(0, 300)}`).toBe(true);
  const session = sessionFrom(handed.exchange.setCookies);
  if (!session || !handed.callback || !handed.startCookie) throw new Error('the sign-in did not go through OpenID Connect');
  return { session, callback: handed.callback, startCookie: handed.startCookie };
}

beforeAll(async () => {
  roles = await startThreeRoles('across', {
    rootEnv: async (rootUrl) => {
      issuer = await startStandInIssuer({ redirectUris: [providerCallbackUrl(rootUrl, 'oidc')] });
      return { OIDC_ISSUER: issuer.issuer, OIDC_CLIENT_ID: issuer.clientId, OIDC_CLIENT_SECRET: issuer.clientSecret, OIDC_LABEL: 'Stand-in' };
    },
  });
  ({ root, instance, hub, mail, owner, instanceId, mongoUri, databases } = roles);
});

afterAll(async () => {
  await roles?.close();
  await issuer?.close();
});

describe('signing in across root, an instance and the hub, each its own process', () => {
  it('root offers only the providers it is configured for, refuses a sign-up through one with no invite, makes the account with an invite and finds it again by its subject', async () => {
    const person = { sub: `provider-${STAMP}`, email: `provider-${STAMP}@across.test`, email_verified: true };
    const offered = (await call(`${root.url}/api/auth/sign-in`)).body as { providers: { id: string; label: string }[] };
    expect(offered.providers.find((provider) => provider.id === 'oidc')).toEqual({ id: 'oidc', label: 'Stand-in' });
    expect(offered.providers.some((provider) => provider.id === 'github')).toBe(false);
    expect((await call(`${root.url}/api/auth/provider/github`)).status).toBe(404);
    const throughProvider = async (invite?: string): Promise<{ session?: string | undefined; landed: string }> => {
      const started = await fetch(`${root.url}/api/auth/provider/oidc${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`, { redirect: 'manual' });
      expect(started.status).toBe(302);
      const sentTo = new URL(started.headers.get('location')!);
      expect(sentTo.origin).toBe(issuer.issuer);
      expect(sentTo.searchParams.get('code_challenge_method')).toBe('S256');
      expect(sentTo.searchParams.get('nonce') && sentTo.searchParams.get('state')).toBeTruthy();
      const stateCookie = started.headers.getSetCookie().map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?oauth_state=/.test(pair))!;
      const back = await issuer.authorize(sentTo.href);
      expect(`${back.origin}${back.pathname}`).toBe(providerCallbackUrl(root.url, 'oidc'));
      const finished = await fetch(back, { redirect: 'manual', headers: { cookie: stateCookie } });
      expect(finished.status).toBe(302);
      return { session: sessionFrom(finished.headers.getSetCookie()), landed: finished.headers.get('location') ?? '' };
    };
    issuer.signInAs(person);
    const uninvited = await throughProvider();
    expect(uninvited.session).toBeUndefined();
    expect(new URL(uninvited.landed).searchParams.get('authError')).toMatch(/invite code is required/);
    const invite = await call(`${root.url}/api/admin/invites`, { method: 'POST', body: {}, cookie: owner.cookie });
    const invited = await throughProvider((invite.body as { code: string }).code);
    expect(invited.session).toBeTruthy();
    const madeAccount = (await call(`${root.url}/api/auth/me`, { cookie: invited.session })).body as { id: string; email: string; emailVerified: boolean };
    expect(madeAccount).toMatchObject({ email: person.email, emailVerified: true });
    issuer.signInAs({ ...person, email: `renamed-${person.email}`, email_verified: false });
    const again = await throughProvider();
    expect(((await call(`${root.url}/api/auth/me`, { cookie: again.session })).body as { id: string }).id).toBe(madeAccount.id);
  });

  it('each answers at its own address, root holds no one\'s work, and the instance starts a sign-in through root', async () => {
    for (const url of [root.url, instance.url, hub.url]) expect((await call(`${url}/api/auth/sign-in`)).status).toBe(200);
    expect(((await call(`${instance.url}/api/auth/sign-in`)).body as { url: string }).url).toBe('/api/auth/oidc/start');
    expect((await call(`${instance.url}/api/conversations`)).status).toBe(401);
    expect(((await call(`${root.url}/api/auth/me`, { cookie: owner.cookie })).body as { id?: string }).id).toBe(owner.id);
    expect((await call(`${root.url}/api/identity/instance`, { cookie: owner.cookie })).body).toEqual({ instance: { id: instanceId, url: instance.url }, servesTenants: false });
    for (const path of ['/api/conversations', '/api/infrastructure', '/api/projects']) expect((await call(`${root.url}${path}`, { cookie: owner.cookie })).status).toBe(404);
  });

  let session = '';
  let hubSession = '';

  it('root signs the owner in to the instance by code, PKCE and state, once and only in the browser that started it; the instance makes no accounts', async () => {
    await until('root to send the owner on to the instance', async () => {
      const went = await call(`${root.url}/api/identity/go`, { cookie: owner.cookie });
      return went.location === `${instance.url}/api/auth/oidc/start` ? true : waiting(`root answered ${went.status} with location ${went.location}`);
    });
    const atInstance = fetchSide(instance.url);
    const signedIn = await signedInThrough(fetchSide(root.url, owner.cookie), atInstance, '/api/identity/go');
    expect((await atInstance(signedIn.callback, { cookie: signedIn.startCookie })).status).toBe(401);
    expect((await atInstance(signedIn.callback)).status).toBe(400);
    session = signedIn.session;
    expect((await call(`${instance.url}/api/conversations`, { cookie: session })).status).toBe(200);
    const me = (await call(`${instance.url}/api/auth/me`, { cookie: session })).body as { id: string; permissions?: Record<string, boolean> };
    expect(me.id).toBe(owner.id);
    expect(me.permissions?.['change-instance-settings']).toBe(true);
    for (const path of ['/api/auth/register', '/api/auth/login']) {
      expect((await call(`${instance.url}${path}`, { method: 'POST', body: {} })).status).toBe(401);
      expect((await call(`${instance.url}${path}`, { method: 'POST', body: {}, cookie: session })).status).toBe(404);
    }
  });

  it('someone else with a root account is sent nowhere by root and stopped at the instance\'s door', async () => {
    const invite = await call(`${root.url}/api/admin/invites`, { method: 'POST', body: {}, cookie: owner.cookie });
    const strangerEmail = `stranger-${STAMP}@across.test`;
    const asked = await call(`${root.url}/api/auth/register`, { method: 'POST', body: { email: strangerEmail, password: `pw-${STAMP}-stranger-long`, inviteCode: (invite.body as { code: string }).code } });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const codeMail = await until(`the sign-up code mail to ${strangerEmail}`, async () => mail.received.find((message) => message.to.includes(strangerEmail) && /sign-up code/i.test(mail.subjectOf(message) ?? '')) ?? waiting(`${mail.received.length} mails received, subjects: ${mail.received.map((message) => mail.subjectOf(message)).join(' | ').slice(0, 200)}`));
    const code = /\b(\d{6})\b/.exec(codeMail.data)?.[1];
    const verified = await fetch(`${root.url}/api/auth/register/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: (asked.body as { verify: string }).verify, code }) });
    expect(verified.status, await verified.clone().text()).toBe(200);
    const strangerCookie = sessionFrom(verified.headers.getSetCookie())!;
    expect(strangerCookie).toBeTruthy();
    expect((await call(`${root.url}/api/identity/go`, { cookie: strangerCookie })).status).toBe(404);
    const atTheDoor = await followSignIn(fetchSide(root.url, strangerCookie), fetchSide(instance.url), new URL(`${instance.url}/api/auth/oidc/start`)).catch((err: Error) => err);
    if (atTheDoor instanceof Error) expect(atTheDoor.message).toMatch(/root stopped the sign-in/);
    else expect(sessionFrom(atTheDoor.exchange.setCookies)).toBeUndefined();
  });

  it('the instance has root send its mail with a service token, and root refuses a wrong credential', async () => {
    const sent = await call(`${instance.url}/api/notifications/test-email`, { method: 'POST', body: {}, cookie: session });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await until('a mail to the owner', async () => (mail.received.some((message) => message.to.includes(owner.email)) ? true : waiting(`${mail.received.length} mails received, none to the owner`)));
    const forged = await call(`${root.url}/api/instances/mail`, { method: 'POST', body: { subject: 'x', text: 'x' }, headers: { 'X-Instance-Id': instanceId, Authorization: 'Bearer not-it' } });
    expect(forged.status).toBe(401);
  });

  it('the hub signs the owner in through root too', async () => {
    hubSession = (await signedInThrough(fetchSide(root.url, owner.cookie), fetchSide(hub.url), '/api/identity/go?to=hub')).session;
    const hubMe = await call(`${hub.url}/api/auth/me`, { cookie: hubSession });
    expect(hubMe.status).toBe(200);
    expect((hubMe.body as { onHub?: boolean }).onHub).toBe(true);
  });

  it('root emails the owner once its instance has been gone past its threshold and once it is back; root gone shows on the instance and clears', async () => {
    onTestFailed(() => console.log(`mail: ${mail.received.map((message) => mail.subjectOf(message)).join(' | ')}\n── root ──\n${root.logs(80)}\n── instance ──\n${instance.logs(40)}`));
    const rootDown = async () => {
      const answer = await call(`${instance.url}/api/infrastructure`, { cookie: session });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return (answer.body as { dependencies: { dependency: string }[] }).dependencies.some((down) => down.dependency === 'root');
    };
    const rootLease = await leaseMongo(`${mongoUri}${databases.root}`);
    const rootClient = rootLease.client;
    const presentAtRoot = async () => {
      const watch = await rootClient.db(databases.root).collection('instanceWatches').findOne({ _id: instanceId as never }) as { presence?: boolean; reach?: { reachable?: boolean } } | null;
      return watch?.presence === true && watch.reach?.reachable === true ? true : waiting(`presence ${watch?.presence}, reachable ${watch?.reach?.reachable}`);
    };
    try {
      await until('root to see the instance present and reachable', presentAtRoot);
      expect(await rootDown()).toBe(false);
      await instance.stop();
      const down = await mailTo(new RegExp(`Your instance .*\\(${instanceId}\\) has not answered for \\d+ minutes`));
      expect(down.to).toEqual([owner.email]);
      await instance.start();
      await mailTo(new RegExp(`Your instance .*\\(${instanceId}\\) answers again`));
      await until('root to see the instance present and reachable again', presentAtRoot);
      await root.stop();
      await until('the instance to show root as down', async () => ((await rootDown()) ? true : waiting('the instance does not list root as down')));
      await root.start();
      await until('the instance to stop showing root as down', async () => ((await rootDown()) ? waiting('the instance still lists root as down') : true));
    } finally {
      await rootLease.release();
    }
  });

  it('signing out everywhere on root ends the instance\'s and the hub\'s sessions at once, and revokes a run\'s grant', async () => {
    const run = await call(`${instance.url}/api/engine/runs`, { method: 'POST', body: { agent: 'koala', message: 'hello from the sign-in test' }, cookie: session });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const runId = (run.body as { runId: string }).runId;
    const { client, release } = await leaseMongo(`${mongoUri}${databases.instance}`);
    const grantOf = async () => client.db(databases.instance).collection('runGrants').findOne({ runId }) as Promise<{ state: string; personId: string; revokedBecause?: string } | null>;
    try {
      await until('the run\'s grant to be live', async () => {
        const state = (await grantOf())?.state;
        return state === 'live' ? true : waiting(`the grant is ${state ?? 'not there'}`);
      });
      expect((await grantOf())?.personId).toBe(owner.id);
      expect((await call(`${root.url}/api/auth/sessions/end-others`, { method: 'POST', body: {}, cookie: owner.cookie })).status).toBe(200);
      await until('the instance to end the owner\'s session', async () => {
        const status = (await call(`${instance.url}/api/auth/me`, { cookie: session })).status;
        return status === 401 ? true : waiting(`the instance answers ${status}`);
      });
      await until('the hub to end the owner\'s session', async () => {
        const status = (await call(`${hub.url}/api/auth/me`, { cookie: hubSession })).status;
        return status === 401 ? true : waiting(`the hub answers ${status}`);
      });
      await until('the run\'s grant to be revoked', async () => {
        const state = (await grantOf())?.state;
        return state === 'revoked' ? true : waiting(`the grant is ${state ?? 'not there'}`);
      });
      expect((await grantOf())?.revokedBecause).toBe('signed-out-everywhere');
    } finally {
      await release();
    }
  });
});
