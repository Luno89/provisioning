import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../apps/backend/src/lib/dev-split.js';

const ENV_DIR = fileURLToPath(new URL('../apps/backend/data/dev-split/', import.meta.url));
const step = (message: string) => console.log(`\n▶ ${message}`);

interface Answer { status: number; location: string | null; cookie: string | undefined; body: unknown }

async function call(url: string, init: RequestInit & { cookie?: string | undefined } = {}): Promise<Answer> {
  const { cookie, headers, ...rest } = init;
  const response = await fetch(url, {
    redirect: 'manual',
    ...rest,
    headers: { ...(headers as Record<string, string> | undefined), ...(cookie ? { Cookie: cookie } : {}), ...(rest.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const set = response.headers.getSetCookie().map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('session='));
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, location: response.headers.get('location'), cookie: set, body };
}

async function main(): Promise<void> {
  const root = readEnvFile(await readFile(`${ENV_DIR}root.env`, 'utf8'));
  const instance = readEnvFile(await readFile(`${ENV_DIR}instance.env`, 'utf8'));
  const rootUrl = root.PUBLIC_URL!;
  const instanceUrl = instance.PUBLIC_URL!;

  step(`both answer at their own addresses: root ${rootUrl}, the instance ${instanceUrl}`);
  for (const url of [rootUrl, instanceUrl]) {
    const page = await call(`${url}/`);
    assert.equal(page.status, 200, `${url} did not serve the app`);
  }

  step('signed out, the instance sends you to root to sign in');
  const where = await call(`${instanceUrl}/api/auth/sign-in`);
  assert.deepEqual(where.body, { url: `${rootUrl}/api/identity/go` });
  assert.equal((await call(`${instanceUrl}/api/conversations`)).status, 401);

  step('you sign in at root, through its Google sign-in as it runs on a dev machine');
  const google = await call(`${rootUrl}/api/auth/google`);
  assert.equal(google.status, 302, JSON.stringify(google.body));
  const callback = await call(google.location!.startsWith('http') ? google.location! : `${rootUrl}${google.location}`);
  assert.equal(callback.status, 302, JSON.stringify(callback.body));
  assert.ok(callback.cookie, 'root set no session');
  const atRoot = callback.cookie;
  const me = await call(`${rootUrl}/api/auth/me`, { cookie: atRoot });
  assert.equal((me.body as { id?: string }).id, instance.INSTANCE_OWNER_ID);
  console.log(`  signed in at root as ${instance.INSTANCE_OWNER_ID}`);

  step('root holds no one\'s work: it knows your instance and serves none of its routes');
  assert.deepEqual((await call(`${rootUrl}/api/identity/instance`, { cookie: atRoot })).body, { instance: { id: instance.INSTANCE_ID, url: instanceUrl }, servesTenants: false });
  for (const path of ['/api/conversations', '/api/infrastructure', '/api/projects']) {
    const answer = await call(`${rootUrl}${path}`, { cookie: atRoot });
    assert.equal(answer.status, 404, `root answered ${path} with ${answer.status}`);
  }

  step('root hands you to your instance with a one-time token, and the instance signs you in');
  const go = await call(`${rootUrl}/api/identity/go`, { cookie: atRoot });
  assert.equal(go.status, 302);
  const handoff = new URL(go.location!);
  assert.equal(handoff.origin, instanceUrl);
  const token = new URLSearchParams(handoff.hash.split('?')[1] ?? '').get('token');
  assert.ok(token, `no token in ${go.location}`);
  const signedIn = await call(`${instanceUrl}/api/auth/handoff`, { method: 'POST', body: JSON.stringify({ token }) });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.ok(signedIn.cookie, 'the instance set no session');
  const atInstance = signedIn.cookie;
  assert.equal((await call(`${instanceUrl}/api/auth/handoff`, { method: 'POST', body: JSON.stringify({ token }) })).status, 409, 'the same token signed in twice');
  console.log('  signed in on the instance; the token does not work a second time');

  step('your work is on the instance');
  const conversations = await call(`${instanceUrl}/api/conversations`, { cookie: atInstance });
  assert.equal(conversations.status, 200);
  const infrastructure = await call(`${instanceUrl}/api/infrastructure`, { cookie: atInstance });
  assert.equal(infrastructure.status, 200, JSON.stringify(infrastructure.body).slice(0, 300));
  console.log(`  ${(conversations.body as unknown[]).length} conversations; Infrastructure reads ${(infrastructure.body as { monitoring: { clusters: unknown[] } }).monitoring.clusters.length} cluster(s)`);
  for (const path of ['/api/auth/register', '/api/auth/login']) {
    const answer = await call(`${instanceUrl}${path}`, { method: 'POST', body: '{}' });
    assert.equal(answer.status, 404, `the instance answered ${path} with ${answer.status}`);
  }
  console.log('  and it makes no accounts of its own');

  step('the instance asks root for what only root does, with its credential');
  const mail = await call(`${instanceUrl}/api/notifications/test-email`, { method: 'POST', body: '{}', cookie: atInstance });
  const said = JSON.stringify(mail.body);
  if (mail.status === 200) console.log('  root sent the test email');
  else {
    assert.doesNotMatch(said, /unknown instance or credential/, 'root did not take the instance\'s credential');
    assert.match(said, /email is not set up|sends no email/, said);
    console.log(`  root took the credential and answered: ${(mail.body as { error: string }).error}`);
  }
  const forged = await call(`${rootUrl}/api/instances/mail`, { method: 'POST', body: JSON.stringify({ subject: 'x', text: 'x' }), headers: { 'X-Instance-Id': instance.INSTANCE_ID!, Authorization: 'Bearer not-it' } });
  assert.equal(forged.status, 401, 'root took a wrong credential');
  console.log('  and refuses a wrong one');

  console.log('\ndev split live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
