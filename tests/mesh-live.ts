import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { sessionToken } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { ACP_STUB, chatsOnTheMachine } from './lib/machine-chat.js';
import { k3sMirror } from './lib/k3s-mirror.js';
import { createDisposableVm, type DisposableVm } from './lib/disposable-vm.js';
import { devDataMounts, devTemporalCa } from './lib/dev-temporal.js';
import { fetchSide, handOff, sessionFrom, signedInLanding } from './lib/handoff.js';
import { dropSuiteDatabase, firstAdmin, forgetMeshUser, suiteRoot, workerEnv } from './lib/suite-root.js';

const GATEWAY_PORT = 30322;
const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
dotenv.config({ path: join(REPO, 'apps/backend/.env'), quiet: true });

const ROOT = suiteRoot('mesh-live', 9474);
let ownerId: string | undefined;
const STAMP = Date.now().toString(36);
const ROOT_PORT = 3251;
const INSTANCE_PORT = 3252;
const ROOT_FOR_HOST = `http://localhost:${ROOT_PORT}`;
const ROOT_FOR_GUEST = `http://10.0.2.2:${ROOT_PORT}`;
const INSTANCE_URL = `http://127.0.0.1:${INSTANCE_PORT}`;
const MESH = 'http://10.0.2.2:8080';
const IMAGE = 'nowrinkles/app:dev';
const TAG = 'mesh-live';
const ROOT_CONTAINER = 'nw-mesh-root';
const WORKER_CONTAINER = 'nw-mesh-worker';
const OTHER_USER = `mesh-live-other-${STAMP}`;

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

async function whatWasThere(): Promise<void> {
  const [instanceVm, machineVm] = vms;
  const looks: Array<[DisposableVm | undefined, string, string]> = [
    [instanceVm, 'the instance\'s pods', 'sudo k3s kubectl get pods -A -o wide'],
    [instanceVm, 'the instance\'s backend', 'sudo k3s kubectl -n nowrinkles logs deploy/instance-backend --tail=150'],
    [instanceVm, 'the instance\'s cluster worker', 'sudo k3s kubectl -n nowrinkles logs deploy/instance-worker-cluster --tail=150'],
    [instanceVm, 'the instance\'s engine worker', 'sudo k3s kubectl -n nowrinkles logs deploy/instance-worker-engine --tail=80'],
    [machineVm, 'the machine\'s agent', 'journalctl --user -u koala-machine --no-pager -n 150'],
    [machineVm, 'the machine\'s k3s', 'systemctl status k3s --no-pager -n 40; sudo k3s kubectl get pods -A 2>&1 | head -40'],
    [machineVm, 'what the machine\'s cluster did', 'sudo k3s kubectl get deploy,rs,quota,limitrange -A 2>&1 | grep -v kube-system | head -40; sudo k3s kubectl get events -A --sort-by=.lastTimestamp 2>&1 | grep -v Normal | tail -40'],
  ];
  for (const [vm, what, command] of looks) {
    if (!vm) continue;
    const seen = await inVm(vm, `${command} 2>&1 || true`).catch((err: Error) => err.message);
    console.error(`\n── ${what} ──\n${seen}`);
  }
}

async function teardown(): Promise<void> {
  for (const name of [ROOT_CONTAINER, WORKER_CONTAINER]) try { run('docker', ['rm', '-f', name]); } catch { /* not running */ }
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
  if (ownerId) forgetMeshUser(ownerId);
  await dropSuiteDatabase(ROOT).catch(() => undefined);
  for (const vm of vms) await vm.destroy();
}

async function main(): Promise<void> {
  const k3s = await k3sMirror();
  step('root\'s registry holds the image');
  run('docker', ['tag', IMAGE, `127.0.0.1:5000/nowrinkles/app:${TAG}`]);
  run('docker', ['push', '-q', `127.0.0.1:5000/nowrinkles/app:${TAG}`]);

  step('root starts, with the mesh at its address on this computer');
  for (const name of [ROOT_CONTAINER, WORKER_CONTAINER]) try { run('docker', ['rm', '-f', name]); } catch { /* not running */ }
  run('docker', ['run', '-d', '--name', ROOT_CONTAINER, '--network', 'host', '--env-file', 'apps/backend/.env', ...ROOT.env, ...devTemporalCa(),
    ...devDataMounts(),
    '-e', 'ROLE=root', '-e', `PORT=${ROOT_PORT}`, '-e', `PUBLIC_URL=${ROOT_FOR_GUEST}`,
    '-e', `MESH_LOGIN_SERVER=${MESH}`, '-e', 'INSTANCE_REGISTRY=10.0.2.2:5001', '-e', `INSTANCE_IMAGE_TAG=${TAG}`, IMAGE, 'backend']);
  await until('root answering', 3, async () => ((await fetch(`${ROOT_FOR_HOST}/api/identity/keys`)).ok ? true : undefined));
  run('docker', ['run', '-d', '--name', WORKER_CONTAINER, '--network', 'host', '--env-file', 'apps/backend/.env', ...ROOT.env, ...devTemporalCa(),
    ...devDataMounts(), ...workerEnv(ROOT), IMAGE, 'worker-host']);
  const owner = await firstAdmin(ROOT_FOR_HOST, ROOT);
  ownerId = owner.id;
  const session = sessionToken(owner, loadKeys(process.env).session, { seconds: 4 * 3600 });
  const asOwner = (path: string, init: RequestInit = {}) => fetch(`${ROOT_FOR_HOST}${path}`, { ...init, headers: { 'content-type': 'application/json', Cookie: `session=${session}`, ...(init.headers ?? {}) } });

  step('the owner adds a machine at root that puts their Koala on itself; it joins the mesh, installs k3s and helm, and the agent installs Koala there');
  const instanceVm = await boot(`mesh-inst-${STAMP}`, { memoryMB: 12288, cpus: 4, diskGB: 60, loopback: [{ host: INSTANCE_PORT, guest: 30320 }] });
  await inVm(instanceVm, `mkdir -p ~/.config/koala && printf 'publicUrl: "%s"\\n' '${INSTANCE_URL}' > ~/.config/koala/koala-values.yaml`);
  const adding = await asOwner('/api/my-machines/join-code', { method: 'POST', body: JSON.stringify({ koalaName: `mesh${STAMP}` }) });
  assert.equal(adding.status, 201, `root did not give a machine command: ${await adding.clone().text()}`);
  const { command: addCommand } = await adding.json() as { command: string };
  assert.match(addCommand, /\/machine\.sh \| sh -s -- /);
  const joinedHere = await inVm(instanceVm, `${addCommand} --yes --k3s-mirror ${k3s.url}`, true);
  assert.match(joinedHere, /helm v[0-9.]+ installed/, 'the join brought no helm');
  const placed = await until('the owner\'s Koala installed on the machine and reporting ready to root', 30, async () => {
    const { instance } = await (await asOwner('/api/instances/mine')).json() as { instance: { id: string; status: string; detail?: string; url?: string } | null };
    if (instance?.status === 'failed') throw new Error(`putting Koala on the machine failed: ${instance.detail}`);
    return instance?.status === 'ready' ? instance : undefined;
  });
  instanceId = placed.id;
  assert.equal(placed.url, INSTANCE_URL, 'the instance does not answer at the address the machine\'s own values give it');
  const mine = await (await asOwner('/api/my-machines')).json() as { machines: Array<{ id: string; holdsKoala: boolean; online: boolean }> };
  assert.equal(mine.machines.filter((machine) => machine.holdsKoala && machine.online).length, 1, `root does not list the machine holding Koala: ${JSON.stringify(mine)}`);
  assert.doesNotMatch(await inVm(instanceVm, 'sudo k3s kubectl -n nowrinkles get deploy instance-worker-host -o yaml'), /docker\.sock/, 'Koala\'s host worker mounts the machine\'s Docker');
  instanceMeshIp = await meshIp(instanceVm);
  console.log(`  the instance is ${instanceMeshIp} on the mesh, put there by its machine's agent`);
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
  const { exchange } = await handOff(fetchSide(ROOT_FOR_HOST, `session=${session}`), fetchSide(INSTANCE_URL));
  assert.ok(signedInLanding(exchange), `the instance did not sign the owner in: ${exchange.status} ${exchange.body.slice(0, 300)}`);
  const cookie = (sessionFrom(exchange.setCookies) ?? '');
  const onInstance = (path: string, init: RequestInit = {}) => fetch(`${INSTANCE_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) } });

  step('a machine of the owner\'s runs the command from the instance\'s My Machines, and joins the mesh with it');
  const machineVm = await boot(`mesh-mach-${STAMP}`, { memoryMB: 6144, cpus: 2, diskGB: 20 });
  const node = process.version;
  await inVm(machineVm, `mkdir -p ~/.local/node ~/agents && curl -fsSL https://nodejs.org/dist/${node}/node-${node}-linux-x64.tar.xz | tar -xJf - -C ~/.local/node --strip-components=1`);
  await inVm(machineVm, `printf '%s\\n' 'export PATH="$HOME/.local/node/bin:$HOME/agents:$PATH"' >> ~/.profile`);
  await inVm(machineVm, `echo ${Buffer.from(ACP_STUB).toString('base64')} | base64 -d > ~/agents/gemini && chmod 755 ~/agents/gemini && head -c 19 ~/agents/gemini`);
  await inVm(machineVm, `sudo sysctl -qw net.ipv4.conf.all.route_localnet=1 && sudo iptables -t nat -A OUTPUT -o lo -d 127.0.0.1 -p tcp --dport ${INSTANCE_PORT} -j DNAT --to-destination 10.0.2.2:${INSTANCE_PORT} && sudo iptables -t nat -A POSTROUTING -d 10.0.2.2 -j MASQUERADE`);
  const made = await onInstance('/api/mesh/local-agents/join-code', { method: 'POST', body: '{}' });
  assert.equal(made.status, 201, await made.clone().text());
  const { command } = await made.json() as { command: string };
  const installed = await inVm(machineVm, `${command} --yes --k3s-mirror ${k3s.url}`, true);
  assert.match(installed, /on the private network as 100\./);
  const machineMeshIp = await meshIp(machineVm);
  const settings = JSON.parse(await inVm(machineVm, 'cat ~/.config/koala/machine.json')) as { deviceId: string };
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

  step('the join installed k3s on the machine, stopped, and the instance keeps its cluster as stopped until something runs on it');
  assert.match(installed, /k3s v[0-9.]+\+k3s[0-9]+ installed, stopped until Koala has work here/);
  assert.match(await inVm(machineVm, 'systemctl is-active k3s || true'), /inactive|unknown/);
  const clusterId = `machine-${machine.id}`;
  const clusterOf = async () => ((await (await onInstance('/api/clusters')).json()) as Array<{ id: string; status: string; provider: string }>).find((entry) => entry.id === clusterId);
  assert.deepEqual(await until('the instance recording the machine\'s cluster', 2, async () => {
    const found = await clusterOf();
    return found ? { provider: found.provider, status: found.status } : undefined;
  }), { provider: 'machine', status: 'stopped' });
  const kubectlOnMachine = (args: string) => inVm(machineVm, `k3s kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml ${args}`);

  step('an app deployed to the machine\'s cluster starts its k3s, runs there, and its ingress answers over the mesh where the instance\'s edge reaches it');
  const deployOn = async (name: string) => {
    const answer = await onInstance('/api/deployments', { method: 'POST', body: JSON.stringify({ name, clusterId, appType: 'audiobookshelf', strategy: 'native' }) });
    assert.equal(answer.status, 202, await answer.clone().text());
    return (await answer.json() as { id: string }).id;
  };
  const appOf = async (id: string) => ((await (await onInstance('/api/deployments')).json()) as Array<{ id: string; status: string; namespace?: string }>).find((entry) => entry.id === id);
  const running = (id: string) => until(`${id} running on the machine`, 30, async () => {
    const found = await appOf(id);
    if (found?.status === 'failed') throw new Error(`${id} failed to deploy on the machine`);
    return found?.status === 'running' ? found : undefined;
  });
  const books = await deployOn('books');
  const booksApp = await running(books);
  assert.equal((await clusterOf())?.status, 'healthy');
  assert.match(await inVm(machineVm, 'systemctl is-active k3s'), /^active/);
  const pods = await kubectlOnMachine(`get pods -n ${booksApp.namespace} -o jsonpath="{.items[*].status.phase}"`);
  assert.match(pods, /Running/, `the app's pods on the machine are ${pods}`);
  const nodePort = (await kubectlOnMachine('get service -n traefik traefik -o jsonpath="{.spec.ports[?(@.name==\'web\')].nodePort}"')).trim();
  assert.match(nodePort, /^\d+$/, 'the machine\'s cluster has no ingress for the edge to reach');
  const viaMesh = (await inVm(instanceVm, `curl -s -o /dev/null -w "%{http_code}" -H "Host: ${booksApp.namespace}.apps.local" http://${machineMeshIp}:${nodePort}/`)).trim();
  assert.ok(Number(viaMesh) > 0 && Number(viaMesh) < 400, `the app answered ${viaMesh} over the mesh`);
  assert.equal(await reaches(instanceVm, machineMeshIp, 6443), true, 'the instance does not reach the machine\'s cluster over the mesh');
  console.log(`  books runs in ${booksApp.namespace} on ${machineMeshIp}, answering ${viaMesh} through its ingress on :${nodePort}`);

  step('the machine keeps only collectors, sending to the instance\'s Prometheus, which reads books and alerts when it stops answering');
  const monitoringPods = await kubectlOnMachine('get pods -n monitoring -o name');
  assert.match(monitoringPods, /prom-agent/, `the machine runs no Prometheus agent: ${monitoringPods}`);
  assert.doesNotMatch(monitoringPods, /grafana|alertmanager|pod\/prometheus-/, `the machine runs a monitoring stack of its own: ${monitoringPods}`);
  const health = await until('the instance reading books from what the machine sends', 5, async () => {
    const view = await (await onInstance(`/api/monitoring/apps/${books}`)).json() as { app: { state: string; numbers: { probed?: number; up?: number; podsRunning?: number } } };
    return view.app.numbers.probed && view.app.numbers.up === 1 && view.app.numbers.podsRunning ? view.app : undefined;
  });
  const firingOnMachine = async () => ((await (await onInstance('/api/monitoring/alerts')).json()) as { firing: Array<{ clusterId: string; name: string; about: { kind: string; deploymentId?: string } }> }).firing
    .filter((alert) => alert.clusterId === clusterId && alert.about.kind === 'app' && alert.about.deploymentId === books);
  await kubectlOnMachine(`scale deployment --all -n ${booksApp.namespace} --replicas=0`);
  const fired = await until('an alert on the instance about books, stopped on the machine', 8, async () => {
    const alerts = await firingOnMachine();
    return alerts.length ? alerts : undefined;
  });
  await kubectlOnMachine(`scale deployment --all -n ${booksApp.namespace} --replicas=1`);
  await until('the alert about books resolving once it answers again', 8, async () => ((await firingOnMachine()).length ? undefined : true));
  await running(books);
  console.log(`  books read on the instance as ${health.state} (${JSON.stringify(health.numbers)}); stopped, ${fired.map((alert) => alert.name).join(', ')} fired for it there and resolved once it answered`);

  step('with the machine offline, a deploy waits and Needs attention says so; when it connects again the app deploys');
  await inVm(machineVm, 'systemctl --user stop koala-machine');
  await until('the instance seeing the machine offline', 2, async () => {
    const list = await (await onInstance('/api/mesh/local-agents')).json() as { id: string; online: boolean }[];
    return list.find((entry) => entry.id === machine.id)?.online === false ? true : undefined;
  });
  const notes = await deployOn('notes');
  const waiting = await until('Needs attention naming the offline machine', 3, async () => {
    const overview = await (await onInstance('/api/monitoring')).json() as { attention: Array<{ subject: { id: string }; state: string; reasons: string[] }> };
    return overview.attention.find((entry) => entry.subject.id === notes && entry.reasons.some((reason) => reason.includes('offline')));
  });
  console.log(`  ${waiting.state}: ${waiting.reasons.join('; ')}`);
  await inVm(machineVm, 'systemctl --user start koala-machine');
  await running(notes);

  step('destroying the apps stops k3s once nothing is left on it');
  for (const id of [books, notes]) {
    const destroyed = await onInstance(`/api/deployments/${id}`, { method: 'DELETE' });
    assert.ok(destroyed.status < 300, await destroyed.clone().text());
  }
  await until('both apps gone', 10, async () => ((await appOf(books)) || (await appOf(notes)) ? undefined : true));
  await until('k3s stopped on the machine', 5, async () => (/inactive|failed/.test(await inVm(machineVm, 'systemctl is-active k3s || true')) ? true : undefined));
  assert.equal((await clusterOf())?.status, 'stopped');
  assert.equal(await reaches(instanceVm, machineMeshIp, 6443), false, 'the machine\'s cluster still answers after it was stopped');
  console.log('  k3s is stopped and the machine\'s cluster shows stopped');

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
    ['someone else → the owner\'s machine\'s cluster', otherVm, machineMeshIp, 6443, false],
  ];
  for (const [what, from, address, port, wanted] of matrix) {
    const got = await reaches(from, address, port);
    console.log(`  ${got === wanted ? '✓' : '✗'} ${what}: ${got ? 'reached' : 'blocked'}`);
    assert.equal(got, wanted, `${what} was ${got ? 'reached' : 'blocked'}`);
  }

  step('removing the machine on the instance takes it off the mesh through root, stops its agent, uninstalls its k3s and deletes its token, project and cluster');
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
  const k3sLeft = (await inVm(machineVm, 'for f in /usr/local/bin/k3s /etc/sudoers.d/koala-k3s /etc/koala/machine-k3s /etc/systemd/system/k3s.service.d/koala-firewall.conf; do sudo test -e $f && echo $f; done; true')).trim();
  assert.equal(k3sLeft, '', `the machine kept ${k3sLeft}`);
  assert.equal(await clusterOf(), undefined, 'the instance still lists the removed machine\'s cluster');
  await until('the instance dropping the removed machine from the mesh, so it no longer reaches the machine gateway', 2, async () => ((await reaches(machineVm, instanceMeshIp!, GATEWAY_PORT)) ? undefined : true));
  console.log(`  ${machineMeshIp} is off the mesh, its agent ${stopped.split('\n').join(', ')}, its project gone`);

  console.log('\nmesh live — PASS');
}

main()
  .then(async () => { await teardown(); process.exit(0); })
  .catch(async (err) => {
    console.error(err);
    await whatWasThere();
    if (process.env.MESH_KEEP === '1') {
      for (const vm of vms) console.error(`kept: ssh -i ${vm.privateKeyPath} -p ${vm.port} ${vm.username}@${vm.host}`);
      await new Promise(() => undefined);
    }
    await teardown();
    process.exit(1);
  });
