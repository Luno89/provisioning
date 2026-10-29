import assert from 'node:assert/strict';
import { call, devSplitEnv, signInAtInstance, signInAtRoot } from './lib/dev-split-session.js';
import { signedInLanding } from './lib/handoff.js';

const step = (message: string) => console.log(`\n▶ ${message}`);

async function main(): Promise<void> {
  const { root, instance } = await devSplitEnv();
  const rootUrl = root.PUBLIC_URL!;
  const instanceUrl = instance.PUBLIC_URL!;

  step(`both answer at their own addresses: root ${rootUrl}, the instance ${instanceUrl}`);
  for (const url of [rootUrl, instanceUrl]) {
    const page = await call(`${url}/`);
    assert.equal(page.status, 200, `${url} did not serve the app`);
  }

  step('signed out, the instance starts your sign-in through root\'s provider');
  const where = await call(`${instanceUrl}/api/auth/sign-in`);
  assert.deepEqual(where.body, { url: '/api/auth/oidc/start', hub: `${rootUrl}/api/identity/go?to=hub` });
  assert.equal((await call(`${instanceUrl}/api/conversations`)).status, 401);

  step('you sign in at root, through its Google sign-in as it runs on a dev machine');
  const atRoot = await signInAtRoot(rootUrl);
  const me = await call(`${rootUrl}/api/auth/me`, { cookie: atRoot });
  assert.equal((me.body as { id?: string }).id, instance.INSTANCE_OWNER_ID);
  console.log(`  signed in at root as ${instance.INSTANCE_OWNER_ID}`);

  step('root holds no one\'s work: it knows your instance and serves none of its routes');
  assert.deepEqual((await call(`${rootUrl}/api/identity/instance`, { cookie: atRoot })).body, { instance: { id: instance.INSTANCE_ID, url: instanceUrl }, servesTenants: false });
  for (const path of ['/api/conversations', '/api/infrastructure', '/api/projects']) {
    const answer = await call(`${rootUrl}${path}`, { cookie: atRoot });
    assert.equal(answer.status, 404, `root answered ${path} with ${answer.status}`);
  }

  step('root signs you in to your instance through its OpenID provider, and the instance keeps its own session');
  const signedIn = await signInAtInstance(rootUrl, atRoot, instanceUrl);
  assert.equal(signedIn.location, `${instanceUrl}/api/auth/oidc/start`);
  assert.ok(signedInLanding(signedIn.exchange), `the instance did not sign you in: ${signedIn.exchange.status} ${signedIn.exchange.body.slice(0, 300)}`);
  assert.ok(signedIn.session, 'the instance set no session');
  assert.ok(signedIn.startCookie, 'the instance started a sign-in bound to no browser');
  const atInstance = signedIn.session;
  assert.equal((await call(`${instanceUrl}${signedIn.callback}`, { cookie: signedIn.startCookie })).status, 401, 'the same sign-in was taken twice');
  assert.equal((await call(`${instanceUrl}${signedIn.callback}`)).status, 400, 'a browser that did not start the sign-in was let in');
  console.log('  signed in on the instance, only in the browser that started it; the code does not work a second time');

  step('your work is on the instance');
  const conversations = await call(`${instanceUrl}/api/conversations`, { cookie: atInstance });
  assert.equal(conversations.status, 200);
  const infrastructure = await call(`${instanceUrl}/api/infrastructure`, { cookie: atInstance });
  assert.equal(infrastructure.status, 200, JSON.stringify(infrastructure.body).slice(0, 300));
  console.log(`  ${(conversations.body as unknown[]).length} conversations; Infrastructure reads ${(infrastructure.body as { monitoring: { clusters: unknown[] } }).monitoring.clusters.length} cluster(s)`);
  for (const path of ['/api/auth/register', '/api/auth/login']) {
    assert.equal((await call(`${instanceUrl}${path}`, { method: 'POST', body: '{}' })).status, 401, `the instance let a signed-out request reach ${path}`);
    const answer = await call(`${instanceUrl}${path}`, { method: 'POST', body: '{}', cookie: atInstance });
    assert.equal(answer.status, 404, `the instance answered ${path} with ${answer.status}`);
  }
  console.log('  and it makes no accounts of its own');

  step('the instance asks root for what only root does, with a short-lived service token');
  const mail = await call(`${instanceUrl}/api/notifications/test-email`, { method: 'POST', body: '{}', cookie: atInstance });
  const said = JSON.stringify(mail.body);
  if (mail.status === 200) console.log('  root sent the test email');
  else {
    assert.doesNotMatch(said, /unknown instance or credential/, 'root did not take the instance\'s service token');
    assert.match(said, /email is not set up|sends no email/, said);
    console.log(`  root took the service token and answered: ${(mail.body as { error: string }).error}`);
  }
  const forged = await call(`${rootUrl}/api/instances/mail`, { method: 'POST', body: JSON.stringify({ subject: 'x', text: 'x' }), headers: { 'X-Instance-Id': instance.INSTANCE_ID!, Authorization: 'Bearer not-it' } });
  assert.equal(forged.status, 401, 'root took a wrong credential');
  console.log('  and refuses a wrong one');

  step('signing out everywhere at root ends your session on the instance at once');
  assert.equal((await call(`${instanceUrl}/api/auth/me`, { cookie: atInstance })).status, 200);
  const ended = await call(`${rootUrl}/api/auth/sessions/end-others`, { method: 'POST', body: '{}', cookie: atRoot });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  let refused = false;
  for (let tries = 0; tries < 60 && !refused; tries += 1) {
    refused = (await call(`${instanceUrl}/api/auth/me`, { cookie: atInstance })).status === 401;
    if (!refused) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(refused, 'the instance still took the session root revoked');
  console.log('  root told the instance, and it refuses the session');

  console.log('\ndev split live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
