import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { ACP_STUB, chatsOnTheMachine } from './lib/machine-chat.js';
import { createDisposableVm, type DisposableVm } from './lib/disposable-vm.js';
import { devTemporalCa } from './lib/dev-temporal.js';

const GATEWAY_PORT = 30322;
const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
dotenv.config({ path: join(REPO, 'apps/backend/.env') });

const OWNER = process.env.MESH_LIVE_OWNER ?? process.env.CHECKS_LIVE_OWNER;
const STAMP = Date.now().toString(36);
const ROOT_PORT = 3231;
const INSTANCE_PORT = 3232;
const ROOT_FOR_HOST = `http://localhost:${ROOT_PORT}`;
const ROOT_FOR_GUEST = `http://10.0.2.2:${ROOT_PORT}`;
const INSTANCE_URL = `http://127.0.0.1:${INSTANCE_PORT}`;
const MESH = 'http://10.0.2.2:8080';
const IMAGE = 'nowrinkles/app:dev';
const ROOT_CONTAINER = 'nw-mesh-root';
const OTHER_USER = `mesh-live-other-${STAMP}`;
const SECRET_FILES = ['.gitea-admin-password', '.gitea-admin-token', '.headscale-api-key', '.infisical-admin-password', '.infisical-machine-identity', '.infisical-encryption-key', '.infisical-postgres-password', '.infisical-redis-password'];

const run = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const headscale = (...args: string[]) => run('docker', ['exec', 'provisioning-headscale', 'headscale', ...args]);
const step = (message: string) => console.log(`\n▶ ${message}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(what: string, minutes: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + minutes * 60_000;
  let last = '';
  for (;;) {
    const value = await probe().catch((err: Error) => { last = err.message; return undefined; });
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${minutes} minutes${last ? `; the last try said: ${last}` : ''}`);
    await sleep(5000);
  }
}

function inVm(vm: DisposableVm, command: string, stream = false): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('ssh', ['-i', vm.privateKeyPath, '-p', String(vm.port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', `${vm.username}@${vm.host}`, `bash -lc ${JSON.stringify(command)}`]);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; if (stream) process.stdout.write(`    ${String(chunk).replace(/\x1b\[[0-9;]*m/g, '').replace(/\n(?!$)/g, '\n    ')}`); });
    child.stderr.on('data', (chunk) => { out += chunk; if (stream) process.stderr.write(`    ${chunk}`); });
    child.on('close', (code) => (code === 0 ? resolveP(out) : rejectP(new Error(`exited ${code} running: ${command}\n${out.slice(-2000)}`))));
  });
}

const reaches = async (vm: DisposableVm, address: string, port: number): Promise<boolean> =>
  inVm(vm, `nc -z -w 5 ${address} ${port}`).then(() => true, () => false);

const meshIp = async (vm: DisposableVm): Promise<string> => (await inVm(vm, 'tailscale ip -4 | head -n1')).trim();

const vms: DisposableVm[] = [];
let instanceId: string | undefined;
let instanceMeshIp: string | undefined;
const boot = async (name: string, options: Parameters<typeof createDisposableVm>[1]) => {
  const vm = await createDisposableVm(name, options);
  vms.push(vm);
  return vm;
};

async function teardown(): Promise<void> {
  try { run('docker', ['rm', '-f', ROOT_CONTAINER]); } catch { /* not running */ }
  if (instanceId) try { run('npm', ['run', 'instances', '--silent', '-w', 'apps/backend', '--', 'remove', instanceId]); } catch { /* fine */ }
  try {
    const nodes = JSON.parse(headscale('nodes', 'list', '-o', 'json')) as Array<{ id: number; given_name?: string; name?: string; ip_addresses?: string[] }>;
    const ours = (node: { given_name?: string; name?: string; ip_addresses?: string[] }) =>
      (node.given_name ?? node.name ?? '').includes(STAMP) || (node.given_name ?? node.name ?? '').startsWith('inst-') || (instanceMeshIp !== undefined && (node.ip_addresses ?? []).includes(instanceMeshIp));
    for (const node of nodes.filter(ours)) headscale('nodes', 'delete', '-i', String(node.id), '--force');
  } catch { /* nothing joined */ }
  try {
    const users = JSON.parse(headscale('users', 'list', '-o', 'json')) as Array<{ id: number; name: string }>;
    const other = users.find((user) => user.name === OTHER_USER);
    if (other) headscale('users', 'destroy', '--identifier', String(other.id), '--force');
  } catch { /* never made */ }
  for (const vm of vms) await vm.destroy();
}

async function main(): Promise<void> {
  assert.ok(OWNER, 'set MESH_LIVE_OWNER (or CHECKS_LIVE_OWNER) to the person whose instance and machine these are');

  step('the image holds this code, and root\'s registry has it');
  run('docker', ['build', '-q', '-t', IMAGE, '.']);
  run('docker', ['tag', IMAGE, `127.0.0.1:5000/${IMAGE}`]);
  run('docker', ['push', '-q', `127.0.0.1:5000/${IMAGE}`]);

  step('root starts, with the mesh at its address on this computer');
  try { run('docker', ['rm', '-f', ROOT_CONTAINER]); } catch { /* not running */ }
  run('docker', ['run', '-d', '--name', ROOT_CONTAINER, '--network', 'host', '--env-file', 'apps/backend/.env', ...devTemporalCa(),
    ...SECRET_FILES.flatMap((file) => ['-v', `${join(REPO, 'apps/backend/data', file)}:/app/apps/backend/data/${file}:ro`]),
    '-e', 'ROLE=root', '-e', `PORT=${ROOT_PORT}`, '-e', `PUBLIC_URL=${ROOT_FOR_GUEST}`,
    '-e', `MESH_LOGIN_SERVER=${MESH}`, '-e', 'INSTANCE_REGISTRY=10.0.2.2:5001', '-e', 'INSTANCE_IMAGE_TAG=dev', IMAGE, 'backend']);
  await until('root answering', 3, async () => ((await fetch(`${ROOT_FOR_HOST}/api/identity/keys`)).ok ? true : undefined));
  const session = signJWT({ userId: OWNER, email: 'live' }, loadKeys(process.env).session, 4 * 3600);
  const asOwner = (path: string, init: RequestInit = {}) => fetch(`${ROOT_FOR_HOST}${path}`, { ...init, headers: { 'content-type': 'application/json', Cookie: `session=${session}`, ...(init.headers ?? {}) } });

  step('the owner\'s instance is installed on a machine of theirs, and joins the mesh');
  const instanceVm = await boot(`mesh-inst-${STAMP}`, { memoryMB: 12288, cpus: 4, diskGB: 60, loopback: [{ host: INSTANCE_PORT, guest: 30320 }] });
  const joining = await asOwner('/api/instances/join-tokens', { method: 'POST', body: JSON.stringify({ name: `mesh${STAMP}` }) });
  assert.equal(joining.status, 200, `root did not give a join command: ${await joining.clone().text()}`);
  const joinToken = await joining.json() as { token: string };
  instanceId = (await (await asOwner('/api/instances/mine')).json() as { instance: { id: string } }).instance.id;
  await inVm(instanceVm, `curl -fsSL ${ROOT_FOR_GUEST}/install.sh | sudo sh -s -- ${joinToken.token} --yes --url ${INSTANCE_URL}`, true);
  instanceMeshIp = await meshIp(instanceVm);
  console.log(`  the instance is ${instanceMeshIp} on the mesh`);
  const envOf = JSON.parse(await inVm(instanceVm, 'sudo k3s kubectl -n nowrinkles get configmap instance-env -o jsonpath="{.data}"')) as Record<string, string>;
  assert.equal(envOf.MACHINE_TEMPORAL_ADDRESS, `${instanceMeshIp}:${GATEWAY_PORT}`);
  assert.equal(envOf.MESH_LOGIN_SERVER, MESH);

  step('its Temporal answers only inside the instance; machines reach it through the gateway on the mesh');
  const ownAddress = (await inVm(instanceVm, 'hostname -I')).trim().split(/\s+/)[0]!;
  assert.match(ownAddress, /^10\.0\.2\.\d+$/, `the instance's own address is ${ownAddress}`);
  assert.equal(await reaches(instanceVm, instanceMeshIp, 7233), false, 'Temporal answers on the instance\'s mesh address');
  assert.equal(await reaches(instanceVm, ownAddress, 7233), false, `Temporal answers on ${ownAddress}, the instance's own network`);
  assert.equal(await reaches(instanceVm, instanceMeshIp, GATEWAY_PORT), true, 'the machine gateway does not answer on the instance\'s mesh address');
  console.log(`  Temporal answers on neither ${instanceMeshIp}:7233 nor ${ownAddress}:7233; the gateway answers on ${instanceMeshIp}:${GATEWAY_PORT}`);

  step('the owner signs in to the instance');
  const go = await fetch(`${ROOT_FOR_HOST}/api/identity/go`, { headers: { Cookie: `session=${session}` }, redirect: 'manual' });
  const token = decodeURIComponent((go.headers.get('location') ?? '').split('token=')[1] ?? '');
  const exchange = await fetch(`${INSTANCE_URL}/api/auth/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(exchange.status, 200, `the instance refused the token: ${await exchange.text()}`);
  const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0]!;
  const onInstance = (path: string, init: RequestInit = {}) => fetch(`${INSTANCE_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) } });

  step('a machine of the owner\'s runs the command from the instance\'s My Machines, and joins the mesh with it');
  const machineVm = await boot(`mesh-mach-${STAMP}`, { memoryMB: 2048, cpus: 2, diskGB: 10 });
  const node = process.version;
  await inVm(machineVm, `mkdir -p ~/.local/node ~/agents && curl -fsSL https://nodejs.org/dist/${node}/node-${node}-linux-x64.tar.xz | tar -xJf - -C ~/.local/node --strip-components=1`);
  await inVm(machineVm, `printf '%s\\n' 'export PATH="$HOME/.local/node/bin:$HOME/agents:$PATH"' >> ~/.profile`);
  await inVm(machineVm, `echo ${Buffer.from(ACP_STUB).toString('base64')} | base64 -d > ~/agents/gemini && chmod 755 ~/agents/gemini && head -c 19 ~/agents/gemini`);
  await inVm(machineVm, `sudo sysctl -qw net.ipv4.conf.all.route_localnet=1 && sudo iptables -t nat -A OUTPUT -o lo -d 127.0.0.1 -p tcp --dport ${INSTANCE_PORT} -j DNAT --to-destination 10.0.2.2:${INSTANCE_PORT} && sudo iptables -t nat -A POSTROUTING -d 10.0.2.2 -j MASQUERADE`);
  const made = await onInstance('/api/mesh/local-agents/join-code', { method: 'POST', body: '{}' });
  assert.equal(made.status, 201, await made.clone().text());
  const { command } = await made.json() as { command: string };
  const installed = await inVm(machineVm, `${command} --yes`, true);
  assert.match(installed, /on the private network as 100\./);
  const machineMeshIp = await meshIp(machineVm);
  const settings = JSON.parse(await inVm(machineVm, 'cat ~/.config/koala/machine.json')) as { temporalAddress: string; deviceId: string };
  assert.equal(settings.temporalAddress, `${instanceMeshIp}:${GATEWAY_PORT}`, 'the machine was not told to reach the gateway over the mesh');
  assert.equal(await reaches(machineVm, instanceMeshIp, 7233), false, 'the machine reaches the instance\'s Temporal itself');

  step('the machine shows on the instance, and its worker reaches the instance\'s Temporal over the mesh');
  const machine = await until('the machine connecting to the instance', 5, async () => {
    const list = await (await onInstance('/api/mesh/local-agents')).json() as { id: string; online: boolean; agents: { id: string; state: string }[] }[];
    const found = list.find((entry) => entry.id === settings.deviceId);
    return found?.online && found.agents.some((agent) => agent.id === 'gemini' && agent.state === 'ready') ? found : undefined;
  });
  const log = await until('the machine\'s worker polling', 3, async () => {
    const text = await inVm(machineVm, 'journalctl --user -u koala-machine --no-pager');
    return text.includes(`engine worker polling device-${machine.id} at ${instanceMeshIp}:${GATEWAY_PORT}`) ? text : undefined;
  });
  assert.ok(log);
  const pollers = await until('the instance\'s Temporal seeing the machine\'s worker', 3, async () => {
    const pod = (await inVm(instanceVm, 'sudo k3s kubectl -n nowrinkles get pod -l app.kubernetes.io/component=temporal -o jsonpath="{.items[0].metadata.name}"')).trim();
    const described = await inVm(instanceVm, `sudo k3s kubectl -n nowrinkles exec ${pod} -- tctl --address localhost:7236 taskqueue describe --taskqueue device-${machine.id} --taskqueuetype activity`);
    return described.includes(`mesh-mach-${STAMP}`) ? described : undefined;
  });
  console.log(`  ${machineMeshIp} polls device-${machine.id} through the gateway on ${instanceMeshIp}:${GATEWAY_PORT}; the instance's Temporal lists it:\n    ${pollers.trim().split('\n').join('\n    ')}`);

  step('a chat on the machine\'s agent runs there, through the instance\'s Temporal over the mesh, with the instance\'s payload key');
  const said = await chatsOnTheMachine(async (method, path, body) => {
    const answer = await onInstance(`/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await answer.text();
    return { status: answer.status, data: text ? JSON.parse(text) : undefined };
  }, machine.id);
  console.log(said.map((line) => `  ${line}`).join('\n'));

  step('someone else\'s machine on the same mesh reaches neither of them, and neither reaches it');
  headscale('users', 'create', OTHER_USER);
  const otherUser = (JSON.parse(headscale('users', 'list', '-o', 'json')) as Array<{ id: number; name: string }>).find((user) => user.name === OTHER_USER)!;
  const otherKey = (JSON.parse(headscale('preauthkeys', 'create', '--user', String(otherUser.id), '--expiration', '1h', '-o', 'json')) as { key: string }).key;
  const otherVm = await boot(`mesh-other-${STAMP}`, { memoryMB: 1024, cpus: 1, diskGB: 8 });
  await inVm(otherVm, `curl -fsSL https://tailscale.com/install.sh | sh >/dev/null && sudo tailscale up --login-server=${MESH} --authkey=${otherKey} --accept-dns=false`);
  const otherMeshIp = await meshIp(otherVm);
  console.log(`  the other person's machine is ${otherMeshIp}`);
  const matrix: Array<[string, DisposableVm, string, number, boolean]> = [
    ['the owner\'s machine → the owner\'s machine gateway', machineVm, instanceMeshIp, GATEWAY_PORT, true],
    ['the owner\'s machine → the owner\'s Temporal itself', machineVm, instanceMeshIp, 7233, false],
    ['someone else → the owner\'s machine gateway', otherVm, instanceMeshIp, GATEWAY_PORT, false],
    ['someone else → the owner\'s Temporal', otherVm, instanceMeshIp, 7233, false],
    ['someone else → the owner\'s instance', otherVm, instanceMeshIp, 22, false],
    ['someone else → the owner\'s machine', otherVm, machineMeshIp, 22, false],
    ['the owner\'s machine → someone else', machineVm, otherMeshIp, 22, false],
  ];
  for (const [what, from, address, port, wanted] of matrix) {
    const got = await reaches(from, address, port);
    console.log(`  ${got === wanted ? '✓' : '✗'} ${what}: ${got ? 'reached' : 'blocked'}`);
    assert.equal(got, wanted, `${what} was ${got ? 'reached' : 'blocked'}`);
  }

  step('removing the machine on the instance takes it off the mesh through root, stops its agent and deletes its token and project');
  const projectsBefore = await (await onInstance('/api/projects')).json() as { id: string; executionTarget?: { deviceId?: string } }[];
  assert.ok(projectsBefore.some((project) => project.executionTarget?.deviceId === machine.id), 'the machine was added without a project');
  const removed = await onInstance(`/api/mesh/local-agents/${machine.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200, await removed.clone().text());
  await until('the machine\'s node leaving the mesh', 2, async () => {
    const nodes = JSON.parse(headscale('nodes', 'list', '-o', 'json')) as Array<{ ip_addresses?: string[] }>;
    return nodes.some((entry) => entry.ip_addresses?.includes(machineMeshIp)) ? undefined : true;
  });
  const stopped = await until('the machine\'s agent stopping', 2, async () => {
    const state = (await inVm(machineVm, 'systemctl --user is-active koala-machine; test -e ~/.config/koala/machine.json && echo token-kept || echo token-gone; test -e ~/.config/systemd/user/koala-machine.service && echo unit-kept || echo unit-gone')).trim();
    return /^(inactive|failed|unknown)/.test(state) ? state : undefined;
  });
  assert.match(stopped, /token-gone/, stopped);
  assert.match(stopped, /unit-gone/, stopped);
  const projectsAfter = await (await onInstance('/api/projects')).json() as { id: string; executionTarget?: { deviceId?: string } }[];
  assert.ok(!projectsAfter.some((project) => project.executionTarget?.deviceId === machine.id), 'the machine\'s project is still there');
  assert.equal(await reaches(machineVm, instanceMeshIp, GATEWAY_PORT), false, 'the removed machine still reaches the machine gateway');
  console.log(`  ${machineMeshIp} is off the mesh, its agent ${stopped.split('\n').join(', ')}, its project gone`);

  console.log('\nmesh live — PASS');
}

main()
  .then(async () => { await teardown(); process.exit(0); })
  .catch(async (err) => { console.error(err); await teardown(); process.exit(1); });
