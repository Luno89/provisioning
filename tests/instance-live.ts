import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { signJWT } from '../apps/backend/src/lib/auth.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
dotenv.config({ path: join(REPO, 'apps/backend/.env') });

const OWNER = process.env.INSTANCE_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const KEEP = process.argv.includes('--keep');
const CLUSTER = 'inst-live';
const ROOT_PORT = 3211;
const INSTANCE_PORT = 3212;
const ROOT_URL = `http://localhost:${ROOT_PORT}`;
const INSTANCE_URL = `http://127.0.0.1:${INSTANCE_PORT}`;
const IMAGE = 'nowrinkles/app:dev';
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

function teardown(): void {
  if (KEEP) {
    console.log(`\nkept: ${INSTANCE_URL} (cluster ${CLUSTER}, root container nw-live-root)`);
    return;
  }
  try { run('docker', ['rm', '-f', 'nw-live-root']); } catch { /* not running */ }
  try { run(bin('k3d'), ['cluster', 'delete', CLUSTER]); } catch { /* not created */ }
  try { run('npm', ['run', 'instances', '--silent', '-w', 'apps/backend', '--', 'remove', 'inst-live']); } catch { /* not registered */ }
}

async function main(): Promise<void> {
  assert.ok(OWNER, 'set INSTANCE_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user who will own the instance');
  run('docker', ['image', 'inspect', IMAGE]);

  step(`a fresh cluster, ${CLUSTER}, stands in for the owner's own k3s`);
  run(bin('k3d'), ['cluster', 'create', CLUSTER, '-p', `${INSTANCE_PORT}:30320@server:0`, '--wait', '--timeout', '240s', '--kubeconfig-update-default=false']);
  writeFileSync(KUBECONFIG, run(bin('k3d'), ['kubeconfig', 'get', CLUSTER]), { mode: 0o600 });
  run(bin('k3d'), ['image', 'import', IMAGE, '-c', CLUSTER]);

  step('root starts, and publishes its public key');
  run('docker', ['run', '-d', '--name', 'nw-live-root', '--network', 'host', '--env-file', 'apps/backend/.env', '-e', 'ROLE=root', '-e', `PORT=${ROOT_PORT}`, IMAGE, 'backend']);
  const keys = await until('root answering', 3, async () => {
    const response = await fetch(`${ROOT_URL}/api/identity/keys`);
    return response.ok ? (await response.json() as { keys: { publicKey: string }[] }).keys : undefined;
  });
  const publicKeyFile = join(work, 'root.pub');
  writeFileSync(publicKeyFile, keys[0]!.publicKey);

  step('the chart installs the instance, and its setup jobs install the services it uses');
  run(bin('helm'), ['install', 'live', 'charts/instance', '--namespace', 'nowrinkles', '--create-namespace',
    '--set', 'instance.id=inst-live', '--set', `instance.ownerId=${OWNER}`, '--set', `instance.rootUrl=${ROOT_URL}`,
    '--set-file', `instance.rootPublicKeys=${publicKeyFile}`, '--set', `publicUrl=${INSTANCE_URL}`,
    '--set', 'backend.nodePort=30320', '--set', 'hostDocker=false', '--timeout', '30m'], { KUBECONFIG });
  run('npm', ['run', 'instances', '--silent', '-w', 'apps/backend', '--', 'add', 'inst-live', OWNER, INSTANCE_URL]);

  step('the owner signs in at root and is handed to their instance');
  const rootSession = signJWT({ userId: OWNER, email: 'live' }, loadKeys(process.env).session, 300);
  const go = await fetch(`${ROOT_URL}/api/identity/go`, { headers: { Cookie: `session=${rootSession}` }, redirect: 'manual' });
  assert.equal(go.status, 302, 'root did not hand the owner to their instance');
  const location = go.headers.get('location') ?? '';
  assert.ok(location.startsWith(`${INSTANCE_URL}/#/handoff?token=`), `root sent the owner to ${location}`);
  const token = decodeURIComponent(location.split('token=')[1]!);

  const exchange = await fetch(`${INSTANCE_URL}/api/auth/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(exchange.status, 200, `the instance refused the token: ${await exchange.text()}`);
  const instanceSession = (exchange.headers.get('set-cookie') ?? '').split(';')[0]!;
  const replay = await fetch(`${INSTANCE_URL}/api/auth/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(replay.status, 409, 'the instance accepted the same token twice');
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

  const users = run(bin('kubectl'), ['-n', 'nowrinkles', 'exec', 'live-mongo-0', '--', 'sh', '-c', 'mongosh -u admin -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin provisioning --quiet --eval "db.users.countDocuments()"'], { KUBECONFIG }).trim();
  assert.equal(users, '1', 'the instance holds someone other than its owner');
  console.log('\npassed');
}

main()
  .then(() => { teardown(); process.exit(0); })
  .catch((err) => { console.error(err); teardown(); process.exit(1); });
