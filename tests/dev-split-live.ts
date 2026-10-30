import assert from 'node:assert/strict';
import { fetchSide, followSignIn, handOff, sessionFrom, signedInLanding, type Side } from './lib/handoff.js';
import { sessionCookieOf, signUp } from './lib/sign-up.js';
import { startSplitStack, type SplitStack } from './lib/split-stack.js';

const step = (message: string) => console.log(`\n▶ ${message}`);

interface Answer { status: number; location: string; body: unknown }

async function call(url: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.cookie ? { Cookie: init.cookie } : {}), ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, location: response.headers.get('location') ?? '', body };
}

async function eventually(what: string, probe: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 120; tries += 1) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`${what} did not happen within a minute`);
}

async function signedInThrough(root: Side, target: Side, first: string): Promise<{ session: string; callback: string; startCookie: string }> {
  const handed = await handOff(root, target, first);
  assert.ok(signedInLanding(handed.exchange), `the sign-in did not land: ${handed.exchange.status} ${handed.exchange.body.slice(0, 300)}`);
  const session = sessionFrom(handed.exchange.setCookies);
  assert.ok(session, 'no session was set');
  assert.ok(handed.callback && handed.startCookie, 'the sign-in did not go through OpenID Connect');
  return { session, callback: handed.callback, startCookie: handed.startCookie };
}

async function stages(stack: SplitStack): Promise<void> {
  const { rootUrl, instanceUrl, hubUrl, owner } = stack;
  const root = fetchSide(rootUrl, owner.cookie);

  step(`root, the instance and the hub answer at their own addresses: ${rootUrl}, ${instanceUrl}, ${hubUrl}`);
  for (const url of [rootUrl, instanceUrl, hubUrl]) assert.equal((await call(`${url}/`)).status, 200, `${url} did not serve the app`);

  step('signed out, the instance starts a sign-in through root\'s provider');
  const where = await call(`${instanceUrl}/api/auth/sign-in`);
  assert.equal((where.body as { url: string }).url, '/api/auth/oidc/start', JSON.stringify(where.body));
  assert.equal((await call(`${instanceUrl}/api/conversations`)).status, 401);

  step('the owner, who signed up on root with its setup code, is signed in there');
  assert.equal(((await call(`${rootUrl}/api/auth/me`, { cookie: owner.cookie })).body as { id?: string }).id, owner.id);

  step('root holds no one\'s work: it knows the instance and serves none of its routes');
  assert.deepEqual((await call(`${rootUrl}/api/identity/instance`, { cookie: owner.cookie })).body, { instance: { id: stack.instanceId, url: instanceUrl }, servesTenants: false });
  for (const path of ['/api/conversations', '/api/infrastructure', '/api/projects']) {
    assert.equal((await call(`${rootUrl}${path}`, { cookie: owner.cookie })).status, 404, `root answered ${path}`);
  }

  step('the instance names its sign-in key to root, so root sends the owner through OpenID Connect');
  await eventually('root sending the owner to the instance\'s OpenID sign-in', async () =>
    (await call(`${rootUrl}/api/identity/go`, { cookie: owner.cookie })).location === `${instanceUrl}/api/auth/oidc/start`);

  step('root signs the owner in to the instance: code, PKCE and state, and the instance keeps its own session');
  const atInstance = fetchSide(instanceUrl);
  const signedIn = await signedInThrough(root, atInstance, '/api/identity/go');
  assert.equal((await atInstance(signedIn.callback, { cookie: signedIn.startCookie })).status, 401, 'the same code was taken twice');
  assert.equal((await atInstance(signedIn.callback)).status, 400, 'a browser that did not start the sign-in was let in');
  const session = signedIn.session;
  console.log('  signed in on the instance, only in the browser that started it; the code works once');

  step('the owner\'s work is on the instance, and the instance makes no accounts');
  assert.equal((await call(`${instanceUrl}/api/conversations`, { cookie: session })).status, 200);
  const me = (await call(`${instanceUrl}/api/auth/me`, { cookie: session })).body as { id: string; permissions?: Record<string, boolean> };
  assert.equal(me.id, owner.id);
  assert.equal(me.permissions?.['change-instance-settings'], true, `the owner's claims on the instance: ${JSON.stringify(me)}`);
  for (const path of ['/api/auth/register', '/api/auth/login']) {
    assert.equal((await call(`${instanceUrl}${path}`, { method: 'POST', body: {} })).status, 401, `${path} answered signed out`);
    assert.equal((await call(`${instanceUrl}${path}`, { method: 'POST', body: {}, cookie: session })).status, 404, `the instance answered ${path}`);
  }

  step('someone else with a root account is refused at the owner\'s instance');
  const invite = await call(`${rootUrl}/api/admin/invites`, { method: 'POST', body: {}, cookie: owner.cookie });
  assert.ok(invite.status === 200 || invite.status === 201, JSON.stringify(invite.body));
  const strangerEmail = `stranger-${stack.names.stamp}@split.test`;
  const stranger = await signUp(`${rootUrl}/api`, { email: strangerEmail, password: `pw-${stack.names.stamp}-stranger-long`, inviteCode: (invite.body as { code: string }).code }, { mailpitApi: stack.mailpitApi });
  const strangerCookie = sessionCookieOf(stranger);
  assert.ok(strangerCookie, `the stranger could not sign up on root: ${stranger.status} ${stranger.error ?? ''}`);
  const notSent = await call(`${rootUrl}/api/identity/go`, { cookie: strangerCookie });
  assert.equal(notSent.status, 404, `root sent a stranger on: ${notSent.status} ${notSent.location}`);
  console.log(`  root does not send them anywhere: ${(notSent.body as { error: string }).error}`);
  const atTheDoor = await followSignIn(fetchSide(rootUrl, strangerCookie), fetchSide(instanceUrl), new URL(`${instanceUrl}/api/auth/oidc/start`)).catch((err: Error) => err);
  if (atTheDoor instanceof Error) {
    assert.match(atTheDoor.message, /root stopped the sign-in/, atTheDoor.message);
    console.log(`  and going to the instance's sign-in themselves, root stops them: ${atTheDoor.message.slice(0, 200)}`);
  } else {
    assert.equal(sessionFrom(atTheDoor.exchange.setCookies), undefined, `the instance signed a stranger in: ${atTheDoor.exchange.status}`);
    assert.ok(atTheDoor.exchange.status >= 400 || !signedInLanding(atTheDoor.exchange), `the instance let a stranger in: ${atTheDoor.exchange.status}`);
    console.log(`  and going to the instance's sign-in themselves, the instance refuses them: ${atTheDoor.exchange.status} ${atTheDoor.exchange.body.slice(0, 160)}`);
  }

  step('the instance asks root for what only root does with a service token, and root refuses a wrong credential');
  const mail = await call(`${instanceUrl}/api/notifications/test-email`, { method: 'POST', body: {}, cookie: session });
  assert.equal(mail.status, 200, `root did not send the instance's mail: ${JSON.stringify(mail.body)}`);
  await eventually('the test email reaching the owner\'s mailbox', async () => {
    const messages = await (await fetch(`${stack.mailpitApi}/api/v1/search?query=${encodeURIComponent(`to:${owner.email}`)}`)).json() as { messages?: unknown[] };
    return (messages.messages ?? []).length > 0;
  });
  const forged = await call(`${rootUrl}/api/instances/mail`, { method: 'POST', body: { subject: 'x', text: 'x' }, headers: { 'X-Instance-Id': stack.instanceId, Authorization: 'Bearer not-it' } });
  assert.equal(forged.status, 401, 'root took a wrong credential');
  console.log('  root sent the owner the instance\'s email through its own mail server');

  step('the hub signs the owner in through root too');
  const atHub = fetchSide(hubUrl);
  const hubSignIn = await signedInThrough(root, atHub, '/api/identity/go?to=hub');
  const hubMe = await call(`${hubUrl}/api/auth/me`, { cookie: hubSignIn.session });
  assert.equal(hubMe.status, 200, JSON.stringify(hubMe.body));
  assert.equal((hubMe.body as { onHub?: boolean }).onHub, true);

  step('a run the owner starts on the instance holds a grant of their claims');
  const run = await call(`${instanceUrl}/api/engine/runs`, { method: 'POST', body: { agent: 'koala', message: 'hello from the split suite' }, cookie: session });
  assert.equal(run.status, 201, `the run did not start: ${run.status} ${JSON.stringify(run.body)}`);
  const runId = (run.body as { runId: string }).runId;
  const grantOf = async () => {
    const { db, close } = await stack.instanceDb();
    try {
      return await db.collection('runGrants').findOne({ runId }) as { state: string; personId: string; revokedBecause?: string } | null;
    } finally {
      await close();
    }
  };
  await eventually('the run\'s grant being issued', async () => (await grantOf())?.state === 'live');
  assert.equal((await grantOf())?.personId, owner.id);

  step('signing out everywhere on root ends the instance\'s and the hub\'s sessions at once, and revokes the run\'s grant');
  assert.equal((await call(`${instanceUrl}/api/auth/me`, { cookie: session })).status, 200);
  const ended = await call(`${rootUrl}/api/auth/sessions/end-others`, { method: 'POST', body: {}, cookie: owner.cookie });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  await eventually('the instance refusing the session root revoked', async () => (await call(`${instanceUrl}/api/auth/me`, { cookie: session })).status === 401);
  await eventually('the hub refusing the session root revoked', async () => (await call(`${hubUrl}/api/auth/me`, { cookie: hubSignIn.session })).status === 401);
  await eventually('the run\'s grant being revoked', async () => (await grantOf())?.state === 'revoked');
  const grant = await grantOf();
  assert.equal(grant?.revokedBecause, 'signed-out-everywhere', JSON.stringify(grant));
  console.log('  root told the instance and the hub; both refuse the session, and the run lost its grant');
}

async function main(): Promise<void> {
  step('a root, an instance and a hub of their own start in containers from this commit\'s image, each on its own database and Temporal namespace');
  const stack = await startSplitStack();
  console.log(`  root ${stack.rootUrl}, instance ${stack.instanceUrl}, hub ${stack.hubUrl}; namespace ${stack.names.namespace}`);
  try {
    await stages(stack);
  } catch (err) {
    for (const side of ['root', 'instance', 'hub'] as const) console.error(`\n── ${side}'s last lines ──\n${stack.logs(side, 40)}`);
    throw err;
  } finally {
    await stack.stop();
  }
  console.log('\ndev split live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
