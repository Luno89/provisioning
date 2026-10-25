import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { createDisposableVm, type DisposableVm } from './lib/disposable-vm.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
dotenv.config({ path: join(REPO, 'apps/backend/.env') });

const OWNER = process.env.POOL_LIVE_OWNER ?? process.env.INSTANCE_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const IMAGE = process.env.POOL_LIVE_IMAGE ?? 'nowrinkles/app:dev';
const TAG = IMAGE.split(':')[1] ?? 'dev';
const DOMAIN = 'koala.localhost';
const ROOT_PORT = 3241;
const ROOT_FOR_HOST = `http://localhost:${ROOT_PORT}`;
const GUEST_NETWORK = '203.0.113.0/24';
const HOST_FOR_GUEST = '203.0.113.2';
const ROOT_FOR_GUEST = `http://${HOST_FOR_GUEST}:${ROOT_PORT}`;
const TLS_PORT = 8444;
const RELAY_PORT = 18081;
const BRIDGE = '172.17.0.1';
const CADDY_IMAGE = 'nowrinkles/caddy:2.10.2';
const TAILSCALE_IMAGE = 'tailscale/tailscale:v1.88.2';
const SOCAT_IMAGE = 'alpine/socat:1.8.0.3';
const GVISOR_TARBALL = join(REPO, 'tests/.vm-cache/gvisor-20261005.0/gvisor.tar.zstd');
const NAME = `pl${Date.now().toString(36)}`;
const QUEUE = `pool-live-${NAME}`;
const CONTAINERS = { root: 'nw-pool-root', worker: 'nw-pool-worker', caddy: 'nw-pool-caddy', mesh: 'nw-pool-ts', relay: 'nw-pool-relay' };
const SECRET_FILES = ['.gitea-admin-password', '.gitea-admin-token', '.headscale-api-key', '.infisical-admin-password', '.infisical-machine-identity', '.infisical-encryption-key', '.infisical-postgres-password', '.infisical-redis-password'];

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const step = (message: string) => console.log(`\n▶ ${message}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

class Hopeless extends Error {}

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  let last = '';
  for (let tries = 0; ; tries += 1) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      if (err instanceof Hopeless) throw err;
      last = (err as Error).message;
    }
    if (tries > 0 && tries % 24 === 0) console.log(`  still waiting for ${what}${last ? ` (${last.slice(0, 200)})` : ''}`);
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

function toVm(vm: DisposableVm, files: string[], into: string): void {
  run('scp', ['-i', vm.privateKeyPath, '-P', String(vm.port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', ...files, `${vm.username}@${vm.host}:${into}`]);
}

let work = '';
let vm: DisposableVm | undefined;
let instanceId: string | undefined;
let throwawayId: string | undefined;
let target: DisposableVm | undefined;
const ENDING = process.env.POOL_LIVE_ENDING === 'delete' ? 'delete' : 'move';

interface Answer { status: number; body: string; headers: Record<string, string> }

function https(host: string, path: string, init: { method?: string; body?: unknown; cookie?: string } = {}): Answer {
  const args = ['-sS', '-D', '-', '--resolve', `${host}:${TLS_PORT}:127.0.0.1`, '--cacert', join(work, 'ca.crt'), '-X', init.method ?? 'GET'];
  if (init.body !== undefined) args.push('-H', 'content-type: application/json', '--data', JSON.stringify(init.body));
  if (init.cookie) args.push('-H', `cookie: ${init.cookie}`);
  const out = execFileSync('curl', [...args, `https://${host}:${TLS_PORT}${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const blocks = out.split(/\r?\n\r?\n/);
  const head = blocks.shift() ?? '';
  const [statusLine, ...lines] = head.split(/\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status: Number((statusLine ?? '').split(' ')[1]), body: blocks.join('\n\n'), headers };
}

function meshKey(tag: 'tag:platform' | 'tag:pool'): string {
  try { run('docker', ['exec', 'provisioning-headscale', 'headscale', 'users', 'create', 'platform-root']); } catch { /* there already */ }
  const users = JSON.parse(run('docker', ['exec', 'provisioning-headscale', 'headscale', 'users', 'list', '-o', 'json'])) as Array<{ id: number; name: string }>;
  const user = users.find((entry) => entry.name === 'platform-root');
  assert.ok(user, 'the platform-root mesh user is there');
  return (JSON.parse(run('docker', ['exec', 'provisioning-headscale', 'headscale', 'preauthkeys', 'create', '--user', String(user.id), '--tags', tag, '--expiration', '60m', '-o', 'json'])) as { key: string }).key;
}

async function teardown(): Promise<void> {
  const movedId = instanceId;
  if (throwawayId) console.log(`  the throwaway account ${throwawayId} was not removed; remove it from root's admin page`);
  for (const name of Object.values(CONTAINERS)) try { run('docker', ['rm', '-f', name]); } catch { /* not running */ }
  if (instanceId) {
    for (const workflow of ['pool-instance', 'pool-trial', 'pool-remove']) {
      try { run('docker', ['exec', 'provisioning-temporal-1', 'temporal', 'workflow', 'terminate', '--address', 'provisioning-temporal-1:7233', '--workflow-id', `${workflow}-${instanceId}`, '--reason', 'pool-live teardown']); } catch { /* not running */ }
    }
    try { run('npm', ['run', 'instances', '--silent', '-w', 'apps/backend', '--', 'remove', instanceId]); } catch { /* fine */ }
  }
  try {
    const nodes = JSON.parse(run('docker', ['exec', 'provisioning-headscale', 'headscale', 'nodes', 'list', '-o', 'json'])) as Array<{ id: number; given_name?: string; name?: string }>;
    const ours = (name: string) => /^(pool-pool-live|nw-pool-root)/.test(name) || (movedId !== undefined && name === movedId);
    for (const node of nodes.filter((entry) => ours(entry.given_name ?? entry.name ?? ''))) {
      run('docker', ['exec', 'provisioning-headscale', 'headscale', 'nodes', 'delete', '-i', String(node.id), '--force']);
    }
  } catch { /* nothing joined */ }
  await vm?.destroy();
  await target?.destroy();
  if (work) rmSync(work, { recursive: true, force: true });
}

async function main(): Promise<void> {
  assert.ok(OWNER, 'set POOL_LIVE_OWNER (or INSTANCE_LIVE_OWNER) to the user who will try the pool');
  assert.ok(existsSync(GVISOR_TARBALL), `the pinned gVisor release is cached at ${GVISOR_TARBALL}`);
  work = mkdtempSync(join(tmpdir(), 'pool-live-'));
  const caddyDir = join(work, 'caddy');
  for (const folder of ['apps', 'instances', 'instance-sites']) mkdirSync(join(caddyDir, folder), { recursive: true });

  step(`root's registry holds ${IMAGE}, and root's Caddy is built`);
  run('docker', ['tag', IMAGE, `127.0.0.1:5000/nowrinkles/app:${TAG}`]);
  run('docker', ['push', '-q', `127.0.0.1:5000/nowrinkles/app:${TAG}`]);
  run('docker', ['build', '-q', '-t', CADDY_IMAGE, 'docker/caddy']);

  step('root joins its mesh as the platform, and its Caddy listens there with a local certificate authority');
  for (const name of Object.values(CONTAINERS)) try { run('docker', ['rm', '-f', name]); } catch { /* not running */ }
  run('docker', ['run', '-d', '--name', CONTAINERS.relay, '--network', 'host', SOCAT_IMAGE, `TCP-LISTEN:${RELAY_PORT},bind=${BRIDGE},fork,reuseaddr`, 'TCP:127.0.0.1:8080']);
  run('docker', ['run', '-d', '--name', CONTAINERS.mesh, '--cap-add', 'NET_ADMIN', '--device', '/dev/net/tun', '-p', `127.0.0.1:${TLS_PORT}:443`,
    '-e', `TS_AUTHKEY=${meshKey('tag:platform')}`, '-e', `TS_EXTRA_ARGS=--login-server=http://${BRIDGE}:${RELAY_PORT} --accept-dns=false`,
    '-e', 'TS_HOSTNAME=nw-pool-root', '-e', 'TS_USERSPACE=false', '-e', 'TS_STATE_DIR=/var/lib/tailscale', TAILSCALE_IMAGE]);
  await until('root on the mesh', async () => run('docker', ['exec', CONTAINERS.mesh, 'tailscale', 'ip', '-4']).trim() || undefined);
  run('docker', ['run', '-d', '--name', CONTAINERS.caddy, '--network', `container:${CONTAINERS.mesh}`,
    '-e', `DOMAIN=${DOMAIN}`, '-e', `APP_DOMAIN=app.${DOMAIN}`, '-e', `MESH_DOMAIN=mesh.${DOMAIN}`, '-e', 'ROOT_TLS=internal',
    '-v', `${join(REPO, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`,
    '-v', `${join(caddyDir, 'apps')}:/etc/caddy/apps:ro`, '-v', `${join(caddyDir, 'instances')}:/etc/caddy/instances:ro`, '-v', `${join(caddyDir, 'instance-sites')}:/etc/caddy/instance-sites:ro`,
    CADDY_IMAGE]);
  await until('Caddy\'s local certificate authority', async () => {
    run('docker', ['cp', `${CONTAINERS.caddy}:/data/caddy/pki/authorities/local/root.crt`, join(work, 'ca.crt')]);
    return existsSync(join(work, 'ca.crt')) ? true : undefined;
  });

  step('a disposable VM becomes a pool node through scripts/root-node/pool-node.sh: k3s, the mesh as tag:pool, root\'s registry, gVisor');
  vm = await createDisposableVm('pool-live', { memoryMB: 16384, cpus: 6, diskGB: 80, network: GUEST_NETWORK });
  toVm(vm, [join(REPO, 'scripts/root-node/pool-node.sh'), join(REPO, 'scripts/root-node/gvisor.sh'), GVISOR_TARBALL], '/tmp/');
  await inVm(vm, 'which zstd >/dev/null || sudo apt-get install -y -qq zstd >/dev/null');
  await inVm(vm, `sudo sh /tmp/pool-node.sh --login-server http://${HOST_FOR_GUEST}:8080 --authkey ${meshKey('tag:pool')} --registry ${HOST_FOR_GUEST}:5001 --gvisor-tarball /tmp/gvisor.tar.zstd --yes`, true);
  const poolIp = (await inVm(vm, 'tailscale ip -4')).trim().split('\n')[0]!;
  const kubeconfig = (await inVm(vm, 'sudo cat /etc/rancher/k3s/k3s.yaml')).replace('server: https://127.0.0.1:6443', `server: https://127.0.0.1:${vm.k3sApiPort}`);
  const kubeconfigPath = join(work, 'pool-kubeconfig.yaml');
  writeFileSync(kubeconfigPath, kubeconfig, { mode: 0o600 });
  const pool = (args: string[]) => run(join(REPO, 'bin/kubectl'), ['--kubeconfig', kubeconfigPath, ...args]);
  console.log(`  the pool node is ${poolIp} on the mesh`);

  step('root starts with the pool on that node, and its host worker takes the pool\'s work');
  const poolEnv = ['-e', `POOL_ADDRESS=${poolIp}`, '-e', 'POOL_SLOTS=1', '-e', 'POOL_KUBECONFIG=/pool/kubeconfig.yaml', '-e', `POOL_TASK_QUEUE=${QUEUE}`,
    '-e', `POOL_IMAGE=${HOST_FOR_GUEST}:5001/nowrinkles/app`, '-e', `POOL_IMAGE_TAG=${TAG}`, '-e', 'POOL_SLOT_MEMORY_MIB=10240', '-e', 'POOL_TRIAL_DAYS=14',
    '-v', `${kubeconfigPath}:/pool/kubeconfig.yaml:ro`];
  const rootEnv = ['--network', 'host', '--env-file', 'apps/backend/.env',
    ...SECRET_FILES.flatMap((file) => ['-v', `${join(REPO, 'apps/backend/data', file)}:/app/apps/backend/data/${file}:ro`]),
    '-e', 'ROLE=root', '-e', `PUBLIC_URL=${ROOT_FOR_GUEST}`, '-e', `INGRESS_DOMAIN=${DOMAIN}`, '-e', `APP_DOMAIN=app.${DOMAIN}`, '-e', `MESH_DOMAIN=mesh.${DOMAIN}`,
    '-e', `MESH_LOGIN_SERVER=http://${HOST_FOR_GUEST}:8080`, '-e', `INSTANCE_REGISTRY=${HOST_FOR_GUEST}:5001`, '-e', `INSTANCE_IMAGE_TAG=${TAG}`, ...poolEnv];
  run('docker', ['run', '-d', '--name', CONTAINERS.root, ...rootEnv, '--group-add', String(statSync('/var/run/docker.sock').gid), '-v', `${caddyDir}:/app/apps/backend/data/caddy`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock', '-e', `PORT=${ROOT_PORT}`,
    '-e', `CADDY_CONTAINER=${CONTAINERS.caddy}`, '-e', `CADDY_TLS_ADDRESS=127.0.0.1:${TLS_PORT}`, IMAGE, 'backend']);
  run('docker', ['run', '-d', '--name', CONTAINERS.worker, ...rootEnv, '-e', `TEMPORAL_TASK_QUEUE=${QUEUE}`, '-e', 'HEALTH_PORT=0', '-e', 'TEMPORAL_METRICS_PORT=9475', IMAGE, 'worker-host']);
  await until('root answering', async () => ((await fetch(`${ROOT_FOR_HOST}/api/identity/keys`)).ok ? true : undefined));
  const session = signJWT({ userId: OWNER, email: 'live' }, loadKeys(process.env).session, 3600);
  const asOwner = (path: string, init: RequestInit = {}) => fetch(`${ROOT_FOR_HOST}${path}`, { ...init, headers: { 'content-type': 'application/json', Cookie: `session=${session}`, ...(init.headers ?? {}) } });

  step(`the owner is offered a trial on Koala's servers, and starts one named "${NAME}"`);
  const offer = await (await asOwner('/api/instances/pool')).json() as { available: boolean; trialDays?: number; reason?: string };
  assert.deepEqual(offer, { available: true, trialDays: 14 }, `the pool was not offered: ${offer.reason}`);
  const started = await asOwner('/api/instances/pool', { method: 'POST', body: JSON.stringify({ name: NAME }) });
  instanceId = ((await (await asOwner('/api/instances/mine')).json()) as { instance?: { id: string } | null }).instance?.id;
  assert.equal(started.status, 202, await started.clone().text());
  const trial = await started.json() as { id: string; trialEndsAt: string };
  instanceId = trial.id;
  console.log(`  the trial ends ${trial.trialEndsAt}`);

  step('root makes the vcluster, opens its ports on the pool node and installs Koala in it, all under gVisor');
  let said = '';
  const ready = await until('the instance ready', async () => {
    const mine = (await (await asOwner('/api/instances/mine')).json() as { instance: { status: string; detail?: string; url: string } }).instance;
    if (mine.detail && mine.detail !== said) { said = mine.detail; console.log(`  ${mine.status}: ${said}`); }
    if (mine.status === 'failed') throw new Hopeless(`the install failed: ${mine.detail}`);
    return mine.status === 'ready' ? mine : undefined;
  });
  assert.equal(ready.url, `https://${NAME}.${DOMAIN}`);
  const namespace = `pool-${NAME}`;
  const runtimes = pool(['get', 'pods', '-n', namespace, '-o', 'jsonpath={range .items[*]}{.metadata.name}={.spec.runtimeClassName}{"\\n"}{end}']).trim().split('\n');
  assert.ok(runtimes.length >= 10, `only ${runtimes.length} pods in ${namespace}`);
  assert.deepEqual(runtimes.filter((line) => !line.endsWith('=gvisor')), [], 'every pod of the instance runs under gVisor');
  console.log(`  ${runtimes.length} pods in ${namespace}, every one under gVisor`);
  const refused = (() => { try { pool(['run', 'escape', '-n', namespace, '--image=busybox:1.37', '--restart=Never', '--dry-run=server']); return ''; } catch (err) { return (err as Error).message; } })();
  assert.match(refused, /runs under gVisor/, 'a pod without gVisor in a pool namespace is refused');
  const nodePorts = pool(['get', 'services', '-A', '-o', 'jsonpath={range .items[?(@.spec.type=="NodePort")]}{.metadata.namespace}/{.metadata.name}{"\\n"}{end}']).trim();
  assert.equal(nodePorts.split('\n').filter((line) => line.startsWith(namespace)).length, 0, `the pool instance opened a node port: ${nodePorts}`);

  step(`https://${NAME}.${DOMAIN} answers through root's Caddy, over the mesh to the pool node's proxy`);
  await until('root\'s route to the instance', async () => (existsSync(join(caddyDir, 'instances', `${NAME}.caddy`)) ? true : undefined));
  await until('the instance through Caddy', async () => (https(`${NAME}.${DOMAIN}`, '/api/auth/sign-in').status === 200 ? true : undefined));

  step('signing in at root lands on the pool instance');
  const go = await fetch(`${ROOT_FOR_HOST}/api/identity/go`, { headers: { Cookie: `session=${session}` }, redirect: 'manual' });
  assert.equal(go.status, 302);
  const location = go.headers.get('location') ?? '';
  assert.ok(location.startsWith(`https://${NAME}.${DOMAIN}/`), `root sent the owner to ${location}`);
  const token = decodeURIComponent(location.split('token=')[1] ?? '');
  const exchange = https(`${NAME}.${DOMAIN}`, '/api/auth/handoff', { method: 'POST', body: { token } });
  assert.equal(exchange.status, 200, `the instance refused the token: ${exchange.body}`);
  const cookie = (exchange.headers['set-cookie'] ?? '').split(';')[0]!;
  const onInstance = (path: string, init: { method?: string; body?: unknown } = {}) => https(`${NAME}.${DOMAIN}`, path, { ...init, cookie });
  assert.equal(onInstance('/api/auth/me').status, 200);

  step('an agent runs code in a sandbox inside the pool instance');
  const body = "return { host: (await import('node:os')).hostname() }";
  const procedure = { schema: 2, id: 'pool-live', version: '1', name: 'Pool live', describe: 'runs code in a sandbox', budget: {}, start: 'provision', cleanup: 'release',
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
  const saved = onInstance('/api/procedures/pool-live', { method: 'PUT', body: procedure });
  assert.equal(saved.status, 200, `the procedure did not save: ${saved.body}`);
  const runId = (JSON.parse(onInstance('/api/engine/runs', { method: 'POST', body: { agent: 'executor', message: 'live', procedure: 'pool-live' } }).body) as { runId: string }).runId;
  const traces = await until('the run finishing', async () => {
    const list = (JSON.parse(onInstance(`/api/engine/runs/${runId}/traces`).body) as { traces: { node: string; exit?: string; outputs?: { host?: string; reason?: string }; finish?: { outcome: string } }[] }).traces;
    return list.some((trace) => trace.node === 'cleaned') ? list : undefined;
  });
  console.log(`  ${traces.map((trace) => `${trace.node}${trace.exit ? `→${trace.exit}` : ''}`).join(' · ')}`);
  assert.equal(traces.find((trace) => trace.node === 'stamp')?.exit, 'ok', `the code did not run: ${JSON.stringify(traces.find((trace) => trace.node === 'unavailable' || trace.node === 'broke'))}`);
  assert.equal(traces.find((trace) => trace.node === 'stamp')?.outputs?.host, 'workspace', 'the code did not run in a sandbox pod');

  step('an app deployed inside the pool instance: its cluster gets only the operator\'s resources and an ingress, no monitoring stack of its own');
  const json = <T,>(answer: Answer): T => JSON.parse(answer.body) as T;
  const deployed = onInstance('/api/deployments', { method: 'POST', body: { name: 'books', clusterId: 'provisioning-lunorica', appType: 'audiobookshelf', strategy: 'native' } });
  assert.equal(deployed.status, 202, deployed.body);
  const deploymentId = json<{ id: string }>(deployed).id;
  const app = await until('the app running', async () => {
    const found = json<Array<{ id: string; status: string; namespace?: string }>>(onInstance('/api/deployments')).find((entry) => entry.id === deploymentId);
    if (!found) throw new Hopeless('the deployment is gone from the list');
    if (found.status === 'failed') {
      const log = json<{ content?: string }>(onInstance(`/api/logs/app/${deploymentId}`)).content ?? '';
      throw new Hopeless(`the app failed to deploy: ${JSON.stringify(found)}\n${log.slice(-4000)}`);
    }
    return found.status === 'running' ? found : undefined;
  });
  const appNamespace = app.namespace ?? 'books';
  const inside = (virtual: string) => pool(['get', 'pods', '-n', namespace, '-l', `vcluster.loft.sh/namespace=${virtual}`, '-o', 'name']).trim();
  assert.equal(inside('monitoring'), '', 'the pool instance runs a monitoring stack of its own');
  assert.notEqual(inside('traefik'), '', 'the pool instance has no ingress for its apps');
  console.log(`  books runs in ${appNamespace}; no monitoring pods inside, Traefik there`);

  step('it is published at its flat address through the instance\'s edge');
  const exposed = onInstance(`/api/deployments/${deploymentId}/expose`, { method: 'POST', body: { mode: 'public' } });
  assert.equal(exposed.status, 200, exposed.body);
  assert.equal(json<{ publicExposureUrl: string }>(exposed).publicExposureUrl, `https://books-${NAME}.${DOMAIN}`);
  const served = await until('the app at its address', async () => {
    const answer = https(`books-${NAME}.${DOMAIN}`, '/');
    return answer.status < 400 ? answer : undefined;
  });
  console.log(`  ${served.status} from books-${NAME}.${DOMAIN}`);

  step('root probes it on the pool node, and the instance reads it healthy through root');
  await until('root\'s probe of the app', async () => pool(['get', 'probes.monitoring.coreos.com', '-n', namespace, '-l', 'koala.dev/pool-probe=true', '-o', 'name']).trim() || undefined);
  const health = await until('the app healthy through root', async () => {
    const view = json<{ app: { state: string; numbers: { up?: number; memoryBytes?: number } }; history: { byKoala?: boolean }; lines: string[] }>(onInstance(`/api/monitoring/apps/${deploymentId}?range=1h`));
    return view.app.state === 'ok' && view.app.numbers.up === 1 && (view.app.numbers.memoryBytes ?? 0) > 0 ? view : undefined;
  });
  assert.equal(health.history.byKoala, true, 'the app\'s history is not said to be kept by Koala\'s servers');
  console.log(`  ${health.lines.join(' ')}`);

  step('the owner sets an alert through Koala\'s own tool and its card; it fires when the app stops, and resolves when it starts');
  const alertProcedure = { schema: 2, id: 'pool-live-alert', version: '1', name: 'Pool live alert', describe: 'proposes an alert', budget: {}, start: 'propose',
    nodes: [
      { id: 'who', kind: 'persona', settings: {}, position: { x: 0, y: 0 } },
      { id: 'propose', kind: 'call-tool', settings: { tool: 'propose_alert', args: JSON.stringify({ app: 'books', kind: 'down', forMinutes: 0, why: 'pool-live' }) }, position: { x: 260, y: 0 } },
      { id: 'done', kind: 'finish', settings: { outcome: 'ok' }, position: { x: 520, y: 0 } },
      { id: 'broke', kind: 'finish', settings: { outcome: 'failed' }, position: { x: 520, y: 160 } }],
    wires: [
      { from: { node: 'who', socket: 'persona' }, to: { node: 'propose', socket: 'persona' } },
      { from: { node: 'propose', socket: 'text' }, to: { node: 'done', socket: 'result' } },
      { from: { node: 'propose', socket: 'text' }, to: { node: 'broke', socket: 'reason' } }],
    flow: [{ from: 'propose', exit: 'ok', to: 'done' }, { from: 'propose', exit: 'failed', to: 'broke' }],
    groups: [] };
  assert.equal(onInstance('/api/procedures/pool-live-alert', { method: 'PUT', body: alertProcedure }).status, 200);
  const alertRun = json<{ runId: string }>(onInstance('/api/engine/runs', { method: 'POST', body: { agent: 'koala', message: 'live', procedure: 'pool-live-alert' } })).runId;
  const proposed = await until('the alert proposed', async () => {
    const list = json<{ traces: Array<{ node: string; outputs?: { text?: string; reason?: string } }> }>(onInstance(`/api/engine/runs/${alertRun}/traces`)).traces;
    if (list.some((trace) => trace.node === 'broke')) throw new Hopeless(`propose_alert failed: ${JSON.stringify(list.find((trace) => trace.node === 'propose'))}`);
    return list.some((trace) => trace.node === 'done') ? true : undefined;
  });
  assert.ok(proposed);
  const card = json<Array<{ id: string; kind: string; status: string }>>(onInstance('/api/actions')).find((entry) => entry.kind === 'set_alert' && entry.status === 'proposed');
  assert.ok(card, 'no alert card waits for the owner');
  const applied = onInstance(`/api/actions/${card.id}/apply`, { method: 'POST' });
  assert.equal(applied.status, 200, applied.body);
  await until('root\'s rule on the pool node', async () => pool(['get', 'prometheusrules', '-n', namespace, '-l', 'koala.dev/pool-rule=true', '-o', 'name']).trim() || undefined);
  const worker = pool(['get', 'pods', '-n', namespace, '-o', 'name']).trim().split('\n').find((line) => line.startsWith('pod/instance-worker-cluster-'));
  assert.ok(worker, 'the instance\'s cluster worker pod is not found');
  const scale = (replicas: number) => pool(['exec', '-n', namespace, worker.slice(4), '--', 'kubectl', 'scale', 'deployment', '--all', '-n', appNamespace, `--replicas=${replicas}`]);
  scale(0);
  const fired = await until('the alert firing in the instance', async () => {
    const alerts = json<{ firing: Array<{ ruleId?: string; summary: string }> }>(onInstance('/api/monitoring/alerts'));
    return alerts.firing.find((alert) => alert.ruleId);
  });
  console.log(`  fired: ${fired.summary}`);
  scale(1);
  await until('the alert resolved', async () => {
    const alerts = json<{ firing: Array<{ ruleId?: string }>; episodes: Array<{ ruleId?: string; resolvedAt?: string }> }>(onInstance('/api/monitoring/alerts'));
    return !alerts.firing.some((alert) => alert.ruleId) && alerts.episodes.some((episode) => episode.ruleId && episode.resolvedAt) ? true : undefined;
  });
  console.log('  resolved once the app answered again');

  step('nothing inside the pool instance reaches root\'s Prometheus');
  const prometheusIp = pool(['get', 'service', 'kube-prometheus-stack-prometheus', '-n', 'monitoring', '-o', 'jsonpath={.spec.clusterIP}']).trim();
  const backend = pool(['get', 'pods', '-n', namespace, '-o', 'name']).trim().split('\n').find((line) => line.startsWith('pod/instance-backend-'));
  assert.ok(backend, 'the instance\'s backend pod is not found');
  const reach = pool(['exec', '-n', namespace, backend.slice(4), '-c', 'backend', '--', 'node', '-e',
    `fetch('http://${prometheusIp}:9090/-/ready',{signal:AbortSignal.timeout(15000)}).then((r)=>console.log('reached',r.status),(e)=>console.log('refused',e.cause?.code??e.name))`]).trim();
  assert.match(reach, /^refused/, `the pool instance reached root's Prometheus: ${reach}`);
  console.log(`  ${reach}`);

  step('a marker is written into the app\'s own volume, for the move to carry');
  const appPod = JSON.parse(pool(['get', 'pods', '-n', namespace, '-l', `vcluster.loft.sh/namespace=${appNamespace}`, '-o', 'json'])) as {
    items: Array<{ metadata: { name: string }; spec: { volumes?: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }>; containers: Array<{ name: string; volumeMounts?: Array<{ name: string; mountPath: string }> }> } }>;
  };
  const withVolume = appPod.items.flatMap((pod) => pod.spec.containers.map((container) => ({ pod, container })))
    .map(({ pod, container }) => ({ pod: pod.metadata.name, container: container.name, mount: container.volumeMounts?.find((mount) => pod.spec.volumes?.some((volume) => volume.name === mount.name && volume.persistentVolumeClaim)) }))
    .find((entry) => entry.mount);
  assert.ok(withVolume?.mount, `the app has no volume to carry: ${JSON.stringify(appPod.items.map((pod) => pod.metadata.name))}`);
  const marker = `${withVolume.mount.mountPath}/.koala-moved`;
  pool(['exec', '-n', namespace, withVolume.pod, '-c', withVolume.container, '--', 'sh', '-c', `echo ${NAME} > ${marker}`]);
  console.log(`  ${marker} in ${appNamespace}`);

  step('the owner makes a project with a repository and writes a file in it, for the move to carry');
  const project = json<{ id: string }>(onInstance('/api/projects', { method: 'POST', body: { name: 'Moved', giteaRepo: `moved-${NAME}`, createRepo: true } }));
  assert.ok(project.id, 'the project was not made');
  const listing = await until('the project\'s repository', async () => {
    const answer = onInstance(`/api/projects/${project.id}/files`);
    const entries = answer.status === 200 ? json<{ entries: Array<{ name: string; path: string; type: string }> }>(answer).entries.filter((entry) => entry.type === 'file') : [];
    return entries.length ? entries : undefined;
  });
  const movedFile = listing[0]!.path;
  const opened = json<{ content: string; sha: string }>(onInstance(`/api/projects/${project.id}/files/content?path=${encodeURIComponent(movedFile)}`));
  const wrote = onInstance(`/api/projects/${project.id}/files/content`, { method: 'PUT', body: { path: movedFile, content: `${opened.content}\nmade on Koala's servers as ${NAME}\n`, sha: opened.sha } });
  assert.ok(wrote.status < 300, `the file was not written: ${wrote.body}`);

  step('an admin ends the trial in a minute and a half: the instance stops, its pods go, and root stops routing to it');
  const admin = (path: string, init: RequestInit = {}) => asOwner(`/api/instances/pool/admin${path}`, init);
  const listed = await (await admin('')).json() as { instances: Array<{ id: string; name: string; status: string }> };
  assert.ok(listed.instances.some((row) => row.name === NAME), `the admin page does not list ${NAME}`);
  const soon = new Date(Date.now() + 90_000).toISOString();
  const moved = await admin(`/instances/${instanceId}/trial`, { method: 'PUT', body: JSON.stringify({ trialEndsAt: soon }) });
  assert.equal(moved.status, 200, await moved.clone().text());
  await until('the instance paused', async () => {
    const mine = (await (await asOwner('/api/instances/mine')).json() as { instance: { status: string } }).instance;
    return mine.status === 'paused' ? true : undefined;
  });
  await until('its pods gone', async () => (pool(['get', 'pods', '-n', namespace, '--field-selector', 'status.phase!=Succeeded,status.phase!=Failed', '-o', 'name']).trim() === '' ? true : undefined));
  await until('root\'s route removed', async () => (existsSync(join(caddyDir, 'instances', `${NAME}.caddy`)) ? undefined : true));
  console.log('  stopped: nothing running in its namespace, and no route');

  step('the admin moves the end two weeks ahead: it starts again, with its work as it was');
  const later = new Date(Date.now() + 14 * 86_400_000).toISOString();
  assert.equal((await admin(`/instances/${instanceId}/trial`, { method: 'PUT', body: JSON.stringify({ trialEndsAt: later }) })).status, 200);
  await until('the instance running again', async () => {
    const mine = (await (await asOwner('/api/instances/mine')).json() as { instance: { status: string; detail?: string } }).instance;
    if (mine.status === 'failed') throw new Hopeless(`it did not start again: ${mine.detail}`);
    return mine.status === 'ready' ? true : undefined;
  });
  await until('the instance through Caddy again', async () => (https(`${NAME}.${DOMAIN}`, '/api/auth/sign-in').status === 200 ? true : undefined));
  assert.equal(onInstance('/api/procedures/pool-live').status, 200, 'the procedure saved before the pause is gone');
  console.log('  running again, and the procedure saved before the pause is still there');

  if (ENDING === 'move') {
    step('the trial ends again, and the owner moves the stopped instance to a machine of their own from root\'s page');
    assert.equal((await admin(`/instances/${instanceId}/trial`, { method: 'PUT', body: JSON.stringify({ trialEndsAt: new Date(Date.now() + 90_000).toISOString() }) })).status, 200);
    await until('the instance paused again', async () => ((await (await asOwner('/api/instances/mine')).json() as { instance: { status: string } }).instance.status === 'paused' ? true : undefined));
    const moving = await asOwner('/api/instances/move', { method: 'POST' });
    assert.equal(moving.status, 200, await moving.clone().text());
    const moveToken = ((await moving.json()) as { command: string }).command.split(' ').pop()!;
    await until('the stopped instance started for the move', async () => {
      const mine = (await (await asOwner('/api/instances/mine')).json() as { instance: { move?: { state: string; detail?: string } } }).instance;
      return mine.move?.state === 'waiting' && mine.move.detail === 'Waiting for your machine to run the move command' ? true : undefined;
    });
    assert.notEqual(pool(['get', 'pods', '-n', namespace, '--field-selector', 'status.phase=Running', '-o', 'name']).trim(), '', 'the stopped instance said it was ready to move before it ran');

    step('a second VM runs the move command: everything comes over, root switches the address to it, and the pool copy goes');
    target = await createDisposableVm('pool-live-target', { memoryMB: 12288, cpus: 4, diskGB: 60, network: GUEST_NETWORK });
    let movedSaid = '';
    const follow = setInterval(() => {
      void asOwner('/api/instances/mine').then((answer) => answer.json()).then((body: { instance?: { move?: { detail?: string } } }) => {
        const detail = body.instance?.move?.detail;
        if (detail && detail !== movedSaid) { movedSaid = detail; console.log(`  moving: ${detail}`); }
      }).catch(() => undefined);
    }, 5000);
    try {
      await inVm(target, `curl -fsSL ${ROOT_FOR_GUEST}/install.sh | sudo sh -s -- ${moveToken} --yes`, true);
      await until('root switching the instance to the new machine', async () => {
        const mine = (await (await asOwner('/api/instances/mine')).json() as { instance: { status: string; trialEndsAt?: string; move?: { state: string; detail?: string } } }).instance;
        if (mine.move?.state === 'failed') throw new Hopeless(`the move stopped: ${mine.move.detail}`);
        return mine.status === 'ready' && !mine.trialEndsAt && !mine.move ? true : undefined;
      });
    } finally {
      clearInterval(follow);
    }
    await until('the pool copy gone', async () => (pool(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name']).trim() === '' ? true : undefined));
    assert.ok(!pool(['get', 'configmap', 'pool-proxy', '-n', 'kube-system', '-o', 'jsonpath={.data.Caddyfile}']).includes(namespace), 'the proxy still serves the moved instance');

    step('the owner signs in at root and lands on the new machine, with their work there');
    await until('the instance through Caddy on its new machine', async () => (https(`${NAME}.${DOMAIN}`, '/api/auth/sign-in').status === 200 ? true : undefined));
    const goAgain = await fetch(`${ROOT_FOR_HOST}/api/identity/go`, { headers: { Cookie: `session=${session}` }, redirect: 'manual' });
    const againToken = decodeURIComponent((goAgain.headers.get('location') ?? '').split('token=')[1] ?? '');
    const againExchange = https(`${NAME}.${DOMAIN}`, '/api/auth/handoff', { method: 'POST', body: { token: againToken } });
    assert.equal(againExchange.status, 200, `the moved instance refused the owner: ${againExchange.body}`);
    const movedCookie = (againExchange.headers['set-cookie'] ?? '').split(';')[0]!;
    const onMoved = (path: string, init: { method?: string; body?: unknown } = {}) => https(`${NAME}.${DOMAIN}`, path, { ...init, cookie: movedCookie });
    assert.equal(onMoved('/api/procedures/pool-live').status, 200, 'the procedure made on Koala\'s servers is not on the new machine');
    const file = onMoved(`/api/projects/${project.id}/files/content?path=${encodeURIComponent(movedFile)}`);
    assert.equal(file.status, 200, `the project's file cannot be read on the new machine: ${file.body}`);
    assert.match(json<{ content: string }>(file).content, new RegExp(`made on Koala's servers as ${NAME}`));
    const carried = await until('the app running on the new machine with its volume', async () => {
      const read = await inVm(target!, `sudo kubectl get pods -n ${appNamespace} -o name | head -1 | xargs -I{} sudo kubectl exec -n ${appNamespace} {} -c ${withVolume.container} -- cat ${marker}`).catch(() => '');
      return read.trim() === NAME ? read.trim() : undefined;
    });
    assert.equal(carried, NAME);
    const hosts = (await inVm(target, 'hostname')).trim();
    console.log(`  on ${hosts}: the procedure, the project's repository with its file read with the moved key, and ${appNamespace}'s volume with its marker`);
  } else {
    step('the admin deletes it, typing its name: the vcluster, its namespace, its ports and its record go');
    const wrong = await admin(`/instances/${instanceId}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'nope' }) });
    assert.equal(wrong.status, 400);
    const deleted = await admin(`/instances/${instanceId}`, { method: 'DELETE', body: JSON.stringify({ confirm: NAME }) });
    assert.equal(deleted.status, 202, await deleted.clone().text());
    await until('the namespace gone', async () => (pool(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name']).trim() === '' ? true : undefined));
    await until('the record gone', async () => ((await (await asOwner('/api/instances/mine')).json() as { instance: unknown }).instance === null ? true : undefined));
    const proxy = pool(['get', 'configmap', 'pool-proxy', '-n', 'kube-system', '-o', 'jsonpath={.data.Caddyfile}']);
    assert.ok(!proxy.includes(namespace), 'the proxy still serves the deleted instance');
    instanceId = undefined;
  }

  step('an admin on root removes a throwaway account: its instance on its own machine is let go of, and the account goes');
  const invite = await (await asOwner('/api/admin/invites', { method: 'POST', body: '{}' })).json() as { code: string };
  const email = `pool-live-${NAME}@example.com`;
  const registered = await fetch(`${ROOT_FOR_HOST}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: randomBytes(18).toString('base64url'), inviteCode: invite.code }),
  });
  assert.equal(registered.status, 200, await registered.clone().text());
  const people = async () => (await (await asOwner('/api/admin/people')).json() as { people: Array<{ id: string; email: string; instance?: { where: string; name?: string } }> }).people;
  const throwaway = (await people()).find((person) => person.email === email);
  assert.ok(throwaway, 'root\'s admin page does not list the new account');
  throwawayId = throwaway.id;
  const theirs = signJWT({ userId: throwaway.id, email }, loadKeys(process.env).session, 3600);
  const joining = await fetch(`${ROOT_FOR_HOST}/api/instances/join-tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json', Cookie: `session=${theirs}` }, body: JSON.stringify({ name: `${NAME}b` }),
  });
  assert.equal(joining.status, 200, await joining.clone().text());
  assert.equal((await people()).find((person) => person.id === throwaway.id)?.instance?.where, 'own', 'the admin page does not show the account\'s instance');
  const removedAccount = await asOwner(`/api/admin/people/${throwaway.id}`, { method: 'DELETE', body: JSON.stringify({ confirm: email }) });
  assert.equal(removedAccount.status, 202, await removedAccount.clone().text());
  assert.equal((await fetch(`${ROOT_FOR_HOST}/api/auth/me`, { headers: { Cookie: `session=${theirs}` } })).status, 401, 'the removed account is still signed in');
  await until('the account gone from root', async () => ((await people()).some((person) => person.id === throwaway.id) ? undefined : true));
  throwawayId = undefined;
  const second = await (await asOwner('/api/admin/invites', { method: 'POST', body: '{}' })).json() as { code: string };
  const secondEmail = `pool-live-${NAME}-c@example.com`;
  const secondRegistered = await fetch(`${ROOT_FOR_HOST}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: secondEmail, password: randomBytes(18).toString('base64url'), inviteCode: second.code }),
  });
  assert.equal(secondRegistered.status, 200, await secondRegistered.clone().text());
  const secondId = (await people()).find((person) => person.email === secondEmail)?.id;
  assert.ok(secondId, 'root\'s admin page does not list the second account');
  throwawayId = secondId;
  const asSecond = signJWT({ userId: secondId, email: secondEmail }, loadKeys(process.env).session, 3600);
  const nameFree = await (await fetch(`${ROOT_FOR_HOST}/api/instances/name-check?name=${NAME}b`, { headers: { Cookie: `session=${asSecond}` } })).json() as { ok: boolean; problem?: string };
  assert.ok(nameFree.ok, `the removed account's instance name is still taken: ${nameFree.problem}`);
  const secondRemoved = await asOwner(`/api/admin/people/${secondId}`, { method: 'DELETE', body: JSON.stringify({ confirm: secondEmail }) });
  assert.equal(secondRemoved.status, 202, await secondRemoved.clone().text());
  await until('the second account gone from root', async () => ((await people()).some((person) => person.id === secondId) ? undefined : true));
  throwawayId = undefined;
  console.log('  removed, signed out at once, and its instance\'s name is free again');

  console.log('\npool live — PASS');
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.error(`\n${signal}: tearing down`);
    void teardown().finally(() => process.exit(130));
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.env.POOL_LIVE_KEEP) {
      console.log(`  kept for a look: the VM (ssh -i ${vm?.privateKeyPath} -p ${vm?.port} ubuntu@127.0.0.1) and the containers; teardown by hand`);
      return;
    }
    await teardown();
  });
