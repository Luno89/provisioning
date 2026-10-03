import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { createDisposableVm, type DisposableVm } from './lib/disposable-vm.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { signJWT } from '../apps/backend/src/lib/auth.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
dotenv.config({ path: join(REPO, 'apps/backend/.env') });

const OWNER = process.env.INSTANCE_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const ROOT_PORT = 3221;
const INSTANCE_PORT = 3222;
const ROOT_FOR_HOST = `http://localhost:${ROOT_PORT}`;
const ROOT_FOR_GUEST = `http://10.0.2.2:${ROOT_PORT}`;
const INSTANCE_URL = `http://127.0.0.1:${INSTANCE_PORT}`;
const IMAGE = 'nowrinkles/app:dev';

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const step = (message: string) => console.log(`\n▶ ${message}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(what: string, minutes: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${minutes} minutes`);
    await sleep(5000);
  }
}

function inVm(vm: DisposableVm, command: string, stream = false): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('ssh', ['-i', vm.privateKeyPath, '-p', String(vm.port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', `${vm.username}@${vm.host}`, command]);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; if (stream) process.stdout.write(`    ${String(chunk).replace(/\n(?!$)/g, '\n    ')}`); });
    child.stderr.on('data', (chunk) => { out += chunk; if (stream) process.stderr.write(`    ${chunk}`); });
    child.on('close', (code) => (code === 0 ? resolveP(out) : rejectP(new Error(`exited ${code} running: ${command}\n${out.slice(-2000)}`))));
  });
}

let vm: DisposableVm | undefined;
let instanceId: string | undefined;
const SECRET_FILES = ['.gitea-admin-password', '.gitea-admin-token', '.headscale-api-key', '.infisical-admin-password', '.infisical-auth-secret', '.infisical-encryption-key', '.infisical-postgres-password', '.infisical-redis-password'];

async function teardown(): Promise<void> {
  try { run('docker', ['rm', '-f', 'nw-byo-root']); } catch { /* not running */ }
  if (instanceId) try { run('npm', ['run', 'instances', '--silent', '-w', 'apps/backend', '--', 'remove', instanceId]); } catch { /* fine */ }
  try {
    const nodes = JSON.parse(run('docker', ['exec', 'provisioning-headscale', 'headscale', 'nodes', 'list', '-o', 'json'])) as Array<{ id: number; given_name?: string; name?: string }>;
    for (const node of nodes.filter((entry) => (entry.given_name ?? entry.name ?? '').startsWith('inst-'))) {
      run('docker', ['exec', 'provisioning-headscale', 'headscale', 'nodes', 'delete', '-i', String(node.id), '--force']);
    }
  } catch { /* nothing joined */ }
  await vm?.destroy();
}

async function main(): Promise<void> {
  assert.ok(OWNER, 'set INSTANCE_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user who will own the instance');

  step('root\'s registry holds the current image');
  run('docker', ['tag', IMAGE, `127.0.0.1:5000/${IMAGE}`]);
  run('docker', ['push', '-q', `127.0.0.1:5000/${IMAGE}`]);

  step('root starts, as the user\'s machine will see it');
  run('docker', ['run', '-d', '--name', 'nw-byo-root', '--network', 'host', '--env-file', 'apps/backend/.env',
    ...SECRET_FILES.flatMap((file) => ['-v', `${join(REPO, 'apps/backend/data', file)}:/app/apps/backend/data/${file}:ro`]),
    '-e', 'ROLE=root', '-e', `PORT=${ROOT_PORT}`, '-e', `PUBLIC_URL=${ROOT_FOR_GUEST}`,
    '-e', 'MESH_LOGIN_SERVER=http://10.0.2.2:8080', '-e', 'INSTANCE_REGISTRY=10.0.2.2:5001', '-e', 'INSTANCE_IMAGE_TAG=dev', IMAGE, 'backend']);
  await until('root answering', 3, async () => ((await fetch(`${ROOT_FOR_HOST}/api/identity/keys`)).ok ? true : undefined));
  const session = signJWT({ userId: OWNER, email: 'live' }, loadKeys(process.env).session, 3600);
  const asOwner = (path: string, init: RequestInit = {}) => fetch(`${ROOT_FOR_HOST}${path}`, { ...init, headers: { 'content-type': 'application/json', Cookie: `session=${session}`, ...(init.headers ?? {}) } });

  step('a disposable VM plays the user\'s own machine');
  vm = await createDisposableVm('byo-live', { memoryMB: 12288, cpus: 4, diskGB: 60, forwards: [{ host: INSTANCE_PORT, guest: 30320 }] });

  step('the owner asks root for a join command, and runs it on the machine');
  const joinCommand = await (await asOwner('/api/instances/join-tokens', { method: 'POST', body: '{}' })).json() as { token: string; command: string };
  assert.match(joinCommand.command, /\| sudo sh -s -- /);
  instanceId = (await (await asOwner('/api/instances/mine')).json() as { instance: { id: string } }).instance.id;
  await inVm(vm, `curl -fsSL ${ROOT_FOR_GUEST}/install.sh | sudo sh -s -- ${joinCommand.token} --yes --url ${INSTANCE_URL}`, true);

  step('root sees the instance ready');
  const mine = (await (await asOwner('/api/instances/mine')).json() as { instance: { id: string; status: string; url: string } }).instance;
  assert.equal(mine.status, 'ready', `root sees the instance as ${mine.status}`);
  assert.equal(mine.url, INSTANCE_URL);

  step('the owner signs in at root and lands on the instance on their machine');
  const go = await fetch(`${ROOT_FOR_HOST}/api/identity/go`, { headers: { Cookie: `session=${session}` }, redirect: 'manual' });
  assert.equal(go.status, 302);
  const token = decodeURIComponent((go.headers.get('location') ?? '').split('token=')[1] ?? '');
  const exchange = await fetch(`${INSTANCE_URL}/api/auth/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(exchange.status, 200, `the instance refused the token: ${await exchange.text()}`);
  const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0]!;
  const http = (path: string, init: RequestInit = {}) => fetch(`${INSTANCE_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) } });

  step('an agent runs code in a sandbox on the user\'s machine');
  const procedure = { schema: 2, id: 'byo-live', version: '1', name: 'BYO live', describe: 'runs code in a sandbox', budget: {}, start: 'provision', cleanup: 'release',
    nodes: [
      { id: 'provision', kind: 'provision-sandbox', settings: {}, position: { x: 0, y: 0 } },
      { id: 'stamp', kind: 'run-code', settings: { body: "return { host: (await import('node:os')).hostname() }", inputs: [], outputs: [{ name: 'host', type: 'text' }] }, position: { x: 260, y: 0 } },
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
  assert.equal((await http('/api/procedures/byo-live', { method: 'PUT', body: JSON.stringify(procedure) })).status, 200);
  const started = await (await http('/api/engine/runs', { method: 'POST', body: JSON.stringify({ agent: 'executor', message: 'live', procedure: 'byo-live' }) })).json() as { runId: string };
  const traces = await until('the run finishing', 15, async () => {
    const list = (await (await http(`/api/engine/runs/${started.runId}/traces`)).json() as { traces: { node: string; exit?: string; finish?: { outcome: string } }[] }).traces;
    return list.some((trace) => trace.node === 'cleaned') ? list : undefined;
  });
  console.log(`  ${traces.map((trace) => `${trace.node}${trace.exit ? `→${trace.exit}` : ''}`).join(' · ')}`);
  assert.equal(traces.find((trace) => trace.node === 'done')?.finish?.outcome, 'ok', 'the run did not finish ok');

  step('the instance checks root for the version it should run, and reports in');
  await inVm(vm, 'sudo k3s kubectl -n nowrinkles create job --from=cronjob/instance-self-upgrade self-upgrade-now && sudo k3s kubectl -n nowrinkles wait --for=condition=complete job/self-upgrade-now --timeout=300s');
  const after = (await (await asOwner('/api/instances/mine')).json() as { instance: { status: string; detail?: string } }).instance;
  assert.equal(after.status, 'ready');
  assert.equal(after.detail, 'Running dev');

  console.log('\npassed');
}

main()
  .then(async () => { await teardown(); process.exit(0); })
  .catch(async (err) => { console.error(err); await teardown(); process.exit(1); });
