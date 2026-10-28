import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { devTemporalCa } from './lib/dev-temporal.js';
import { fetchSide, handOff } from './lib/handoff.js';
import { signUp } from './lib/sign-up.js';
import { dropSuiteDatabase, firstAdmin, forgetMeshUser, suiteRoot, workerEnv } from './lib/suite-root.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
dotenv.config({ path: join(REPO, 'apps/backend/.env') });

const ROOT = suiteRoot('instance-live', 9471);
const KEEP = process.argv.includes('--keep');
const CLUSTER = 'inst-live';
const ROOT_PORT = 3211;
const INSTANCE_PORT = 3212;
const ROOT_URL = `http://localhost:${ROOT_PORT}`;
const INSTANCE_URL = `http://127.0.0.1:${INSTANCE_PORT}`;
const IMAGE = 'nowrinkles/app:dev';
const MAILBOX = 'nw-live-mailbox';
const WORKER = 'nw-live-worker';
const SECRET_FILES = ['.gitea-admin-password', '.gitea-admin-token', '.headscale-api-key', '.infisical-admin-password', '.infisical-machine-identity', '.infisical-encryption-key', '.infisical-postgres-password', '.infisical-redis-password'];
const MAILPIT_IMAGE = 'axllent/mailpit:v1.21.0';
const MAILPIT_SMTP = 11027;
const MAILPIT_API = 18028;
const bin = (name: string) => join(REPO, 'bin', name);
const work = mkdtempSync(join(tmpdir(), 'instance-live-'));
const KUBECONFIG = join(work, 'kubeconfig');

const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
const step = (message: string) => console.log(`\n▶ ${message}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(what: string, minutes: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${minutes} minutes`);
    await sleep(3000);
  }
}

async function teardown(): Promise<void> {
  if (KEEP) {
    console.log(`\nkept: ${INSTANCE_URL} (cluster ${CLUSTER}, root container nw-live-root, database ${ROOT.database})`);
    return;
  }
  for (const name of ['nw-live-root', WORKER, MAILBOX]) try { run('docker', ['rm', '-f', name]); } catch { /* not running */ }
  try { run(bin('k3d'), ['cluster', 'delete', CLUSTER]); } catch { /* not created */ }
  await dropSuiteDatabase(ROOT).catch(() => undefined);
}

async function main(): Promise<void> {
  run('docker', ['image', 'inspect', IMAGE]);

  step(`a fresh cluster, ${CLUSTER}, stands in for the owner's own k3s`);
  run(bin('k3d'), ['cluster', 'create', CLUSTER, '-p', `${INSTANCE_PORT}:30320@server:0`, '--wait', '--timeout', '240s', '--kubeconfig-update-default=false']);
  writeFileSync(KUBECONFIG, run(bin('k3d'), ['kubeconfig', 'get', CLUSTER]), { mode: 0o600 });
  run(bin('k3d'), ['image', 'import', IMAGE, '-c', CLUSTER]);

  step('root starts, and publishes its public key');
  try { run('docker', ['rm', '-f', MAILBOX]); } catch { /* not running */ }
  run('docker', ['run', '-d', '--name', MAILBOX, '-p', `127.0.0.1:${MAILPIT_SMTP}:1025`, '-p', `127.0.0.1:${MAILPIT_API}:8025`, MAILPIT_IMAGE]);
  run('docker', ['run', '-d', '--name', 'nw-live-root', '--network', 'host', '--env-file', 'apps/backend/.env', ...ROOT.env, ...devTemporalCa(), '-e', 'ROLE=root', '-e', `PORT=${ROOT_PORT}`,
    '-e', `MAIL_SMTP_URL=smtp://127.0.0.1:${MAILPIT_SMTP}`, '-e', 'MAIL_FROM=koala@instance-live.test', IMAGE, 'backend']);
  run('docker', ['run', '-d', '--name', WORKER, '--network', 'host', '--env-file', 'apps/backend/.env', ...ROOT.env, ...devTemporalCa(),
    ...SECRET_FILES.flatMap((file) => ['-v', `${join(REPO, 'apps/backend/data', file)}:/app/apps/backend/data/${file}:ro`]), ...workerEnv(ROOT), IMAGE, 'worker-host']);
  const keys = await until('root answering', 3, async () => {
    const response = await fetch(`${ROOT_URL}/api/identity/keys`);
    return response.ok ? (await response.json() as { keys: { publicKey: string }[] }).keys : undefined;
  });
  const publicKeyFile = join(work, 'root.pub');
  writeFileSync(publicKeyFile, keys[0]!.publicKey);
  const owner = await firstAdmin(ROOT_URL, ROOT);
  const OWNER = owner.id;
  const instances = (args: string[]) => run('npm', ['run', 'instances', '--silent', '-w', 'apps/backend', '--', ...args], { MONGO_URI: ROOT.mongoUri });

  step('the chart installs the instance, and its setup jobs install the services it uses');
  run(bin('helm'), ['install', 'live', 'charts/instance', '--namespace', 'nowrinkles', '--create-namespace',
    '--set', 'instance.id=inst-live', '--set', `instance.ownerId=${OWNER}`, '--set', `instance.rootUrl=${ROOT_URL}`,
    '--set-file', `instance.rootPublicKeys=${publicKeyFile}`, '--set', `publicUrl=${INSTANCE_URL}`,
    '--set', 'backend.nodePort=30320', '--set', 'hostDocker=false', '--timeout', '30m'], { KUBECONFIG });
  instances(['add', 'inst-live', OWNER, INSTANCE_URL]);

  step('the owner signs in at root and is handed to their instance');
  const rootSession = signJWT({ userId: OWNER, email: owner.email }, loadKeys(process.env).session, 300);
  const atInstance = fetchSide(INSTANCE_URL);
  const { exchange, location, token, nonceCookie } = await handOff(fetchSide(ROOT_URL, `session=${rootSession}`), atInstance);
  assert.ok(location.startsWith(`${INSTANCE_URL}/#/handoff?token=`), `root sent the owner to ${location}`);
  assert.ok(nonceCookie, 'the instance took a token bound to no browser');
  assert.equal(exchange.status, 200, `the instance refused the token: ${exchange.body}`);
  const instanceSession = (exchange.setCookies[0] ?? '').split(';')[0]!;
  assert.equal((await atInstance('/api/auth/handoff', { method: 'POST', body: { token }, cookie: nonceCookie })).status, 409, 'the instance accepted the same token twice');
  assert.equal((await atInstance('/api/auth/handoff', { method: 'POST', body: { token } })).status, 401, 'the instance took a token in a browser that did not start the sign-in');
  const http = (path: string, init: RequestInit = {}) => fetch(`${INSTANCE_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', Cookie: instanceSession, ...(init.headers ?? {}) } });

  step('an agent runs code in a sandbox inside the instance\'s cluster');
  const body = "return { host: (await import('node:os')).hostname() }";
  const procedure = { schema: 2, id: 'instance-live', version: '1', name: 'Instance live', describe: 'runs code in a sandbox', budget: {}, start: 'provision', cleanup: 'release',
    nodes: [
      { id: 'provision', kind: 'provision-sandbox', settings: {}, position: { x: 0, y: 0 } },
      { id: 'stamp', kind: 'run-code', settings: { body, inputs: [], outputs: [{ name: 'host', type: 'text' }] }, position: { x: 260, y: 0 } },
      { id: 'done', kind: 'finish', settings: { outcome: 'ok' }, position: { x: 520, y: 0 } },
      { id: 'broke', kind: 'finish', settings: { outcome: 'failed' }, position: { x: 520, y: 160 } },
      { id: 'unavailable', kind: 'finish', settings: { outcome: 'failed' }, position: { x: 260, y: 160 } },
      { id: 'release', kind: 'release-sandbox', settings: {}, position: { x: 0, y: 320 } },
      { id: 'cleaned', kind: 'finish', settings: { outcome: 'ok' }, position: { x: 260, y: 320 } }],
    wires: [
      { from: { node: 'provision', socket: 'environment' }, to: { node: 'stamp', socket: 'environment' } },
      { from: { node: 'provision', socket: 'environment' }, to: { node: 'release', socket: 'environment' } },
      { from: { node: 'provision', socket: 'reason' }, to: { node: 'unavailable', socket: 'reason' } },
      { from: { node: 'stamp', socket: 'host' }, to: { node: 'done', socket: 'result' } },
      { from: { node: 'stamp', socket: 'error' }, to: { node: 'broke', socket: 'reason' } }],
    flow: [{ from: 'provision', exit: 'ready', to: 'stamp' }, { from: 'provision', exit: 'unavailable', to: 'unavailable' }, { from: 'stamp', exit: 'ok', to: 'done' }, { from: 'stamp', exit: 'failed', to: 'broke' }, { from: 'release', exit: 'done', to: 'cleaned' }],
    groups: [] };
  const saved = await http('/api/procedures/instance-live', { method: 'PUT', body: JSON.stringify(procedure) });
  assert.equal(saved.status, 200, `the procedure did not save: ${await saved.text()}`);
  const started = await (await http('/api/engine/runs', { method: 'POST', body: JSON.stringify({ agent: 'executor', message: 'live', procedure: 'instance-live' }) })).json() as { runId: string };
  const traces = await until('the run finishing', 10, async () => {
    const list = (await (await http(`/api/engine/runs/${started.runId}/traces`)).json() as { traces: { node: string; exit?: string; outputs?: { host?: string }; finish?: { outcome: string } }[] }).traces;
    return list.some((trace) => trace.node === 'cleaned') ? list : undefined;
  });
  console.log(`  ${traces.map((trace) => `${trace.node}${trace.exit ? `→${trace.exit}` : ''}`).join(' · ')}`);
  assert.equal(traces.find((trace) => trace.node === 'stamp')?.exit, 'ok', 'the code did not run');
  assert.equal(traces.find((trace) => trace.node === 'done')?.finish?.outcome, 'ok', 'the run did not finish ok');
  assert.equal(traces.find((trace) => trace.node === 'stamp')?.outputs?.host, 'workspace', 'the code did not run in a sandbox pod');

  step('only the instance\'s own pods reach its Temporal, Temporal\'s database and Mongo, and only its namespace reaches its SearXNG and Crawl4AI');
  for (const service of ['searxng', 'crawl4ai']) run(bin('kubectl'), ['-n', service, 'rollout', 'status', `deployment/${service}`, '--timeout=720h'], { KUBECONFIG });
  const targets = [
    ['live.nowrinkles.svc', 80], ['searxng.searxng.svc', 8080], ['crawl4ai.crawl4ai.svc', 11235],
    ['live-temporal.nowrinkles.svc', 7233], ['live-temporal-db.nowrinkles.svc', 5432], ['live-mongo.nowrinkles.svc', 27017],
  ] as const;
  const knock = (only: readonly (typeof targets)[number][]) => `const net = require('net');
const at = ([host, port]) => new Promise((done) => {
  const socket = net.connect(port, host);
  const quiet = setTimeout(() => { socket.destroy(); done('no answer'); }, 5000);
  socket.on('connect', () => { clearTimeout(quiet); socket.destroy(); done('reached'); });
  socket.on('error', (err) => { clearTimeout(quiet); done(err.code); });
});
Promise.all(${JSON.stringify(only)}.map(at)).then((found) => console.log('KNOCKED ' + JSON.stringify(found)));`;
  const kubectl = (args: string[]) => run(bin('kubectl'), args, { KUBECONFIG });
  for (const namespace of ['default', 'nowrinkles']) {
    kubectl(['run', 'knocker', '--namespace', namespace, '--restart=Never', `--image=${IMAGE}`, '--image-pull-policy=Never', '--command', '--', 'sleep', 'infinity']);
  }
  for (const namespace of ['default', 'nowrinkles']) kubectl(['-n', namespace, 'wait', '--for=condition=Ready', 'pod/knocker', '--timeout=720h']);
  const knockFrom = (namespace: string, only: readonly (typeof targets)[number][] = targets): Record<string, string> => {
    const out = kubectl(['-n', namespace, 'exec', 'knocker', '--', 'node', '-e', knock(only)]);
    const found = JSON.parse(out.split('KNOCKED ')[1]!.split('\n')[0]!) as string[];
    return Object.fromEntries(only.map(([host, port], index) => [`${host.split('.')[0]}:${port}`, found[index]!]));
  };
  await until('the network policies knowing the pods started for this check', 10, async () =>
    (knockFrom('nowrinkles', [targets[1]])['searxng:8080'] === 'reached' ? true : undefined));
  const shown = (namespace: string, answers: Record<string, string>) => {
    console.log(`  from ${namespace}: ${Object.entries(answers).map(([target, answer]) => `${target} ${answer}`).join(' · ')}`);
    return answers;
  };
  const stores = ['live-temporal:7233', 'live-temporal-db:5432', 'live-mongo:27017'];
  const elsewhere = shown('default', knockFrom('default'));
  assert.equal(elsewhere['live:80'], 'reached', 'a pod in another namespace could not reach the instance\'s backend, so the cluster\'s network proves nothing here');
  for (const closed of [...stores, 'searxng:8080', 'crawl4ai:11235']) assert.notEqual(elsewhere[closed], 'reached', `a pod in another namespace reached ${closed}`);
  const inside = shown('nowrinkles', knockFrom('nowrinkles'));
  for (const open of ['live:80', 'searxng:8080', 'crawl4ai:11235']) assert.equal(inside[open], 'reached', `a pod in the instance\'s namespace could not reach ${open}`);
  for (const closed of stores) assert.notEqual(inside[closed], 'reached', `a pod in the instance\'s namespace that is not the instance\'s own reached ${closed}`);
  for (const service of ['searxng', 'crawl4ai']) {
    assert.equal(kubectl(['-n', service, 'get', 'service', service, '-o', 'jsonpath={.spec.type}']), 'ClusterIP', `${service} is published on the machine's interfaces`);
  }
  for (const namespace of ['default', 'nowrinkles']) kubectl(['-n', namespace, 'delete', 'pod', 'knocker', '--wait=false']);

  step('the instance\'s own pods reach its Temporal only over TLS, with a token signed by the instance\'s key, and never its internal frontend');
  const temporalPod = kubectl(['-n', 'nowrinkles', 'get', 'pod', '-l', 'app.kubernetes.io/component=temporal', '-o', 'jsonpath={.items[0].status.podIP}']).trim();
  const probe = `import net from 'node:net';
import { readFileSync } from 'node:fs';
import { Client, Connection } from '@temporalio/client';
import { temporalToken } from './src/platform/lib/temporal-auth.ts';
const address = (process.env.TEMPORAL_CONNECTION_ADDRESS ?? '').replace(/^https?:\\/\\//, '');
const grant = { subject: 'instance-live', namespace: 'default', role: 'read' };
const listed = async (apiKey) => {
  try {
    const connection = await Connection.connect({ address, tls: { serverRootCACertificate: readFileSync(process.env.TEMPORAL_TLS_CA ?? '') }, connectTimeout: '10s', ...(apiKey ? { apiKey } : {}) });
    for await (const _ of new Client({ connection }).workflow.list()) break;
    return 'allowed';
  } catch { return 'refused'; }
};
const reached = (host, port) => new Promise((done) => {
  const socket = net.connect(port, host);
  const quiet = setTimeout(() => { socket.destroy(); done('no answer'); }, 5000);
  socket.on('connect', () => { clearTimeout(quiet); socket.destroy(); done('reached'); });
  socket.on('error', (err) => { clearTimeout(quiet); done(err.code); });
});
const found = {
  unsigned: await listed(),
  otherKey: await listed(temporalToken('another-instance-key-'.padEnd(64, 'x'), grant)),
  signed: await listed(temporalToken(process.env.TEMPORAL_KEY, grant)),
  internalFrontend: await reached(${JSON.stringify(temporalPod)}, 7236),
  plainText: await (async () => {
    try {
      const connection = await Connection.connect({ address, tls: false, connectTimeout: '10s', apiKey: temporalToken(process.env.TEMPORAL_KEY, grant) });
      for await (const _ of new Client({ connection }).workflow.list()) break;
      return 'allowed';
    } catch { return 'refused'; }
  })(),
};
console.log('TEMPORAL ' + JSON.stringify(found));
process.exit(0);`;
  const said = execFileSync(bin('kubectl'), ['-n', 'nowrinkles', 'exec', '-i', 'deploy/live-backend', '--', 'sh', '-c', 'cd /app/apps/backend && cat > temporal-probe.mts && npx tsx temporal-probe.mts; status=$?; rm -f temporal-probe.mts; exit $status'], { input: probe, encoding: 'utf8', env: { ...process.env, KUBECONFIG } });
  const temporalAnswers = JSON.parse(said.split('TEMPORAL ')[1]!.split('\n')[0]!) as Record<string, string>;
  console.log(`  from the instance's backend pod: ${Object.entries(temporalAnswers).map(([what, answer]) => `${what} ${answer}`).join(' · ')}`);
  assert.equal(temporalAnswers.signed, 'allowed', 'Temporal refused a token signed by the instance\'s own key');
  assert.equal(temporalAnswers.unsigned, 'refused', 'Temporal answered a call that carried no token');
  assert.equal(temporalAnswers.otherKey, 'refused', 'Temporal answered a token signed by another key');
  assert.notEqual(temporalAnswers.internalFrontend, 'reached', 'another pod reached Temporal\'s internal frontend, which checks nothing');
  assert.equal(temporalAnswers.plainText, 'refused', 'Temporal answered a connection without TLS');

  step('deleting an account is root\'s: the instance removes none and points there, and a person on root removes their own, their instance let go of with it');
  const place = await (await http('/api/auth/account-removal')).json() as { url: string | null };
  assert.equal(place.url, `${ROOT_URL}/#/remove-account`, 'the instance does not send people to root to delete their account');
  assert.equal((await http('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm: 'live' }) })).status, 404, 'the instance still removes accounts itself');
  const asOwner = (path: string, init: RequestInit = {}) => fetch(`${ROOT_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', Cookie: `session=${rootSession}`, ...(init.headers ?? {}) } });
  const invite = await (await asOwner('/api/admin/invites', { method: 'POST', body: '{}' })).json() as { code: string };
  const email = `instance-live-${randomBytes(4).toString('hex')}@example.com`;
  const registered = await signUp(`${ROOT_URL}/api`, { email, password: randomBytes(18).toString('base64url'), inviteCode: invite.code }, { mailpitApi: `http://127.0.0.1:${MAILPIT_API}` });
  assert.equal(registered.status, 200, registered.error);
  console.log('  a throwaway account signed up on root with the code root emailed it');
  const people = async () => (await (await asOwner('/api/admin/people')).json() as { people: Array<{ id: string; email: string }> }).people;
  const leaving = (await people()).find((person) => person.email === email);
  assert.ok(leaving, 'root does not list the new account');
  const theirInstance = `inst-live-${leaving.id.slice(0, 8)}`;
  instances(['add', theirInstance, leaving.id, 'http://127.0.0.1:9']);
  const theirs = signJWT({ userId: leaving.id, email }, loadKeys(process.env).session, 300);
  const asLeaving = (path: string, init: RequestInit = {}) => fetch(`${ROOT_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', Cookie: `session=${theirs}`, ...(init.headers ?? {}) } });
  const preview = await (await asLeaving('/api/account/removal')).json() as { email: string; blockers: string[]; instance?: { where: string } };
  assert.equal(preview.email, email);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.instance?.where, 'own', 'root does not say their instance goes with the account');
  assert.equal((await asLeaving('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm: 'someone-else@example.com' }) })).status, 400, 'root removed an account without its email typed');
  const removed = await asLeaving('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm: email }) });
  assert.equal(removed.status, 202, await removed.clone().text());
  assert.match(removed.headers.get('set-cookie') ?? '', /session=;/, 'root did not sign them out');
  assert.equal((await asLeaving('/api/auth/me')).status, 401, 'the removed account is still signed in');
  await until('the account gone from root', 5, async () => ((await people()).some((person) => person.id === leaving.id) ? undefined : true));
  await until('their instance let go of', 2, async () => (instances(['list']).includes(theirInstance) ? undefined : true));
  console.log('  the instance points at root; the account removed itself there, signed out at once, its instance let go of');

  const users = run(bin('kubectl'), ['-n', 'nowrinkles', 'exec', 'live-mongo-0', '--', 'sh', '-c', 'mongosh -u admin -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin provisioning --quiet --eval "db.users.countDocuments()"'], { KUBECONFIG }).trim();
  assert.equal(users, '1', 'the instance holds someone other than its owner');
  console.log('\npassed');
}

main()
  .then(async () => { await teardown(); process.exit(0); })
  .catch(async (err) => { console.error(err); await teardown(); process.exit(1); });
