import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { UPGRADE_WORDS } from '../apps/backend/src/instances/lib/self-upgrade.js';
import { ACP_STUB, chatsOnTheMachine } from './lib/machine-chat.js';
import { k3sMirror } from './lib/k3s-mirror.js';
import { createDisposableVm, type DisposableVm } from './lib/disposable-vm.js';
import { devDataMounts, devTemporalCa } from './lib/dev-temporal.js';
import { fetchSide, handOff, sessionFrom, signedInLanding } from './lib/handoff.js';
import { dropSuiteDatabase, dropSuiteNamespace, firstAdmin, makeSuiteNamespace, forgetMeshUser, suiteRoot, workerEnv, rootIdentity } from './lib/suite-root.js';
import { until, waiting } from './lib/until.js';
import { containerNotRunning } from './lib/dead-states.js';

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
const INSIDE_WATCH = [
  'echo $$ > /tmp/inside.pid',
  'while true; do',
  '  printf "%s %s\\n" "$(date -u +%H:%M:%S.%N | cut -c1-12)" "$(curl -s -o /dev/null -m 5 -w "%{http_code} %{time_total}" http://127.0.0.1:30320/api/auth/sign-in)"',
  '  sleep 0.5',
  'done',
  '',
].join('\n');

const run = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const headscale = (...args: string[]) => run('docker', ['exec', 'provisioning-headscale', 'headscale', ...args]);
const step = (message: string) => console.log(`\n▶ ${message}`);

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
const gone = async (): Promise<string | undefined> => {
  for (const vm of vms) {
    const reason = await vm.gone();
    if (reason) return reason;
  }
  return containerNotRunning(ROOT_CONTAINER);
};
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
  if (ownerId) await forgetMeshUser(ownerId);
  await dropSuiteDatabase(ROOT).catch(() => undefined);
  await dropSuiteNamespace(ROOT);
  for (const vm of vms) await vm.destroy();
}

async function startRoot(releaseTag: string): Promise<void> {
  try { run('docker', ['rm', '-f', ROOT_CONTAINER]); } catch { /* not running */ }
  run('docker', ['run', '-d', '--name', ROOT_CONTAINER, '--network', 'host', '--env-file', 'apps/backend/.env', ...ROOT.env, ...devTemporalCa(),
    ...devDataMounts(),
    '-e', `PORT=${ROOT_PORT}`, ...rootIdentity(ROOT_FOR_GUEST, { tag: releaseTag, registry: '10.0.2.2:5001' }),
    '-e', `MESH_LOGIN_SERVER=${MESH}`, IMAGE, 'backend']);
  await until('root answering', async () => { const answer = await fetch(`${ROOT_FOR_HOST}/api/identity/keys`); return answer.ok ? true : waiting(`/api/identity/keys answered ${answer.status}`); }, gone);
}

async function main(): Promise<void> {
  const k3s = await k3sMirror();
  step('root\'s registry holds the image');
  run('docker', ['tag', IMAGE, `127.0.0.1:5000/nowrinkles/app:${TAG}`]);
  run('docker', ['push', '-q', `127.0.0.1:5000/nowrinkles/app:${TAG}`]);

  step('root starts, with the mesh at its address on this computer');
  for (const name of [ROOT_CONTAINER, WORKER_CONTAINER]) try { run('docker', ['rm', '-f', name]); } catch { /* not running */ }
  await makeSuiteNamespace(ROOT);
  await startRoot(TAG);
  run('docker', ['run', '-d', '--name', WORKER_CONTAINER, '--network', 'host', '--env-file', 'apps/backend/.env', ...ROOT.env, ...devTemporalCa(),
    ...devDataMounts(), ...rootIdentity(ROOT_FOR_GUEST, { tag: TAG, registry: '10.0.2.2:5001' }), '-e', `MESH_LOGIN_SERVER=${MESH}`, ...workerEnv(ROOT), IMAGE, 'worker-host']);
  const owner = await firstAdmin(ROOT_FOR_HOST, ROOT);
  ownerId = owner.id;
  const session = owner.cookie;
  const asOwner = (path: string, init: RequestInit = {}) => fetch(`${ROOT_FOR_HOST}${path}`, { ...init, headers: { 'content-type': 'application/json', Cookie: session, ...(init.headers ?? {}) } });

  step('the owner adds a machine at root that puts their Koala on itself; it joins the mesh, installs k3s and helm, and the agent installs Koala there');
  const instanceVm = await boot(`mesh-inst-${STAMP}`, { memoryMB: 12288, cpus: 4, diskGB: 60, loopback: [{ host: INSTANCE_PORT, guest: 30320 }] });
  await inVm(instanceVm, `mkdir -p ~/.config/koala && printf 'publicUrl: "%s"\\n' '${INSTANCE_URL}' > ~/.config/koala/koala-values.yaml`);
  const adding = await asOwner('/api/my-machines/join-code', { method: 'POST', body: JSON.stringify({ koalaName: `mesh${STAMP}` }) });
  assert.equal(adding.status, 201, `root did not give a machine command: ${await adding.clone().text()}`);
  const { command: addCommand } = await adding.json() as { command: string };
  assert.match(addCommand, /\/machine\.sh \| sh -s -- /);
  const joinedHere = await inVm(instanceVm, `${addCommand} --yes --k3s-mirror ${k3s.url}`, true);
  assert.match(joinedHere, /helm v[0-9.]+ installed/, 'the join brought no helm');
  const placed = await until('the owner\'s Koala installed on the machine and reporting ready to root', async () => {
    const { instance } = await (await asOwner('/api/instances/mine')).json() as { instance: { id: string; status: string; detail?: string; url?: string } | null };
    return instance?.status === 'ready' ? instance : waiting(instance ? `${instance.status}${instance.detail ? `: ${instance.detail}` : ''}` : 'no instance yet');
  }, async () => {
    const { instance } = await (await asOwner('/api/instances/mine')).json() as { instance: { status: string; detail?: string } | null };
    return (await gone()) ?? (instance?.status === 'failed' ? `putting Koala on the machine failed: ${instance.detail}` : undefined);
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

  step('the machine answers on its node ports on itself and on the mesh, never on its network address, and Infisical, SearXNG and Crawl4AI have none');
  const answer = async (host: string, port: number) => (await inVm(instanceVm, `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${host}:${port}/ || true`)).trim();
  for (const [what, port] of Object.entries({ backend: 30320, gitea: 31737 })) {
    const here = await answer('127.0.0.1', port);
    const onMesh = await answer(instanceMeshIp, port);
    const there = await answer(ownAddress, port);
    console.log(`  ${what} :${port} on 127.0.0.1 ${here}, on the mesh at ${instanceMeshIp} ${onMesh}, on ${ownAddress} ${there}`);
    assert.notEqual(here, '000', `the ${what} did not answer on the machine itself`);
    assert.notEqual(onMesh, '000', `the ${what} did not answer on the machine's mesh address`);
    assert.equal(there, '000', `the ${what} answered on the machine's network address`);
  }
  for (const [namespace, service] of [['infisical', 'infisical-infisical-standalone-infisical'], ['searxng', 'searxng'], ['crawl4ai', 'crawl4ai']]) {
    assert.equal((await inVm(instanceVm, `sudo k3s kubectl -n ${namespace} get service ${service} -o jsonpath='{.spec.type}'`)).trim(), 'ClusterIP', `${service} is published on the machine`);
  }

  step('the owner signs in to the instance');
  const { exchange } = await handOff(fetchSide(ROOT_FOR_HOST, session), fetchSide(INSTANCE_URL));
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
  const machine = await until('the machine connecting to the instance', async () => {
    const list = await (await onInstance('/api/mesh/local-agents')).json() as { id: string; online: boolean; agents: { id: string; state: string }[] }[];
    const found = list.find((entry) => entry.id === settings.deviceId);
    return found?.online && found.agents.some((agent) => agent.id === 'gemini' && agent.state === 'ready') ? found : waiting(found ? `${found.online ? 'online' : 'offline'}, agents ${found.agents.map((agent) => `${agent.id} ${agent.state}`).join(', ') || 'none'}` : `${list.length} machines listed, not this one`);
  }, gone);
  const log = await until('the machine\'s worker polling', async () => {
    const text = await inVm(machineVm, 'journalctl --user -u koala-machine --no-pager');
    return text.includes(`engine worker polling device-${machine.id} at ${instanceMeshIp}:${GATEWAY_PORT}`) ? text : waiting(`the journal's last line: ${text.trim().split('\n').at(-1)?.slice(0, 200) ?? ''}`);
  }, gone);
  assert.ok(log);
  const pollers = await until('the instance\'s Temporal seeing the machine\'s worker', async () => {
    const pod = (await inVm(instanceVm, 'sudo k3s kubectl -n nowrinkles get pod -l app.kubernetes.io/component=temporal -o jsonpath="{.items[0].metadata.name}"')).trim();
    const described = await inVm(instanceVm, `sudo k3s kubectl -n nowrinkles exec ${pod} -- tctl --address localhost:7236 taskqueue describe --taskqueue device-${machine.id} --taskqueuetype activity`);
    return described.includes(`mesh-mach-${STAMP}`) ? described : waiting(`the task queue lists: ${described.trim().slice(0, 200)}`);
  }, gone);
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
  assert.deepEqual(await until('the instance recording the machine\'s cluster', async () => {
    const found = await clusterOf();
    return found ? { provider: found.provider, status: found.status } : waiting(`no ${clusterId} yet`);
  }, gone), { provider: 'machine', status: 'stopped' });
  const kubectlOnMachine = (args: string) => inVm(machineVm, `k3s kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml ${args}`);

  step('an app deployed to the machine\'s cluster starts its k3s, runs there, and its ingress answers over the mesh where the instance\'s edge reaches it');
  const deployOn = async (name: string) => {
    const answer = await onInstance('/api/deployments', { method: 'POST', body: JSON.stringify({ name, clusterId, appType: 'audiobookshelf', strategy: 'native' }) });
    assert.equal(answer.status, 202, await answer.clone().text());
    return (await answer.json() as { id: string }).id;
  };
  const appOf = async (id: string) => ((await (await onInstance('/api/deployments')).json()) as Array<{ id: string; status: string; namespace?: string }>).find((entry) => entry.id === id);
  const running = (id: string) => until(`${id} running on the machine`, async () => {
    const found = await appOf(id);
    return found?.status === 'running' ? found : waiting(found ? `it is ${found.status}` : 'it is not listed');
  }, async () => (await gone()) ?? ((await appOf(id))?.status === 'failed' ? `${id} failed to deploy on the machine` : undefined));
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
  const health = await until('the instance reading books from what the machine sends', async () => {
    const view = await (await onInstance(`/api/monitoring/apps/${books}`)).json() as { app: { state: string; numbers: { probed?: number; up?: number; podsRunning?: number } } };
    return view.app.numbers.probed && view.app.numbers.up === 1 && view.app.numbers.podsRunning ? view.app : waiting(`state ${view.app.state}, probed ${view.app.numbers.probed ?? 'unmeasured'}, up ${view.app.numbers.up ?? 'unmeasured'}, pods running ${view.app.numbers.podsRunning ?? 'unmeasured'}`);
  }, gone);
  const firingOnMachine = async () => ((await (await onInstance('/api/monitoring/alerts')).json()) as { firing: Array<{ clusterId: string; name: string; about: { kind: string; deploymentId?: string } }> }).firing
    .filter((alert) => alert.clusterId === clusterId && alert.about.kind === 'app' && alert.about.deploymentId === books);
  await kubectlOnMachine(`scale deployment --all -n ${booksApp.namespace} --replicas=0`);
  const fired = await until('an alert on the instance about books, stopped on the machine', async () => {
    const alerts = await firingOnMachine();
    return alerts.length ? alerts : waiting('nothing firing on the machine');
  }, gone);
  await kubectlOnMachine(`scale deployment --all -n ${booksApp.namespace} --replicas=1`);
  await until('the alert about books resolving once it answers again', async () => { const firing = await firingOnMachine(); return firing.length ? waiting(`${firing.length} still firing`) : true; }, gone);
  await running(books);
  console.log(`  books read on the instance as ${health.state} (${JSON.stringify(health.numbers)}); stopped, ${fired.map((alert) => alert.name).join(', ')} fired for it there and resolved once it answered`);

  step('with the machine offline, a deploy waits and Needs attention says so; when it connects again the app deploys');
  await inVm(machineVm, 'systemctl --user stop koala-machine');
  await until('the instance seeing the machine offline', async () => {
    const list = await (await onInstance('/api/mesh/local-agents')).json() as { id: string; online: boolean }[];
    const found = list.find((entry) => entry.id === machine.id);
    return found?.online === false ? true : waiting(found ? 'it is still online' : 'it is not listed');
  }, gone);
  const notes = await deployOn('notes');
  const attention = await until('Needs attention naming the offline machine', async () => {
    const overview = await (await onInstance('/api/monitoring')).json() as { attention: Array<{ subject: { id: string }; state: string; reasons: string[] }> };
    return overview.attention.find((entry) => entry.subject.id === notes && entry.reasons.some((reason) => reason.includes('offline'))) ?? waiting(`attention names ${overview.attention.map((entry) => `${entry.subject.id}: ${entry.reasons.join('; ')}`).join(' | ').slice(0, 200) || 'nothing'}`);
  }, gone);
  console.log(`  ${attention.state}: ${attention.reasons.join('; ')}`);
  await inVm(machineVm, 'systemctl --user start koala-machine');
  await running(notes);

  step('destroying the apps stops k3s once nothing is left on it');
  for (const id of [books, notes]) {
    const destroyed = await onInstance(`/api/deployments/${id}`, { method: 'DELETE' });
    assert.ok(destroyed.status < 300, await destroyed.clone().text());
  }
  await until('both apps gone', async () => { const left = [await appOf(books), await appOf(notes)].filter((app) => app !== undefined); return left.length ? waiting(left.map((app) => `${app.id}: ${app.status}`).join(', ')) : true; }, gone);
  await until('k3s stopped on the machine', async () => { const state = (await inVm(machineVm, 'systemctl is-active k3s || true')).trim(); return /inactive|failed/.test(state) ? true : waiting(`k3s is ${state}`); }, gone);
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
  await until('the machine\'s node leaving the mesh', async () => {
    const nodes = JSON.parse(headscale('nodes', 'list', '-o', 'json')) as Array<{ ip_addresses?: string[] }>;
    return nodes.some((entry) => entry.ip_addresses?.includes(machineMeshIp)) ? waiting(`headscale still lists ${machineMeshIp}`) : true;
  }, gone);
  const stopped = await until('the machine\'s agent stopping', async () => {
    const state = (await inVm(machineVm, 'systemctl --user is-active koala-machine; test -e ~/.config/koala/machine.json && echo token-kept || echo token-gone; test -e ~/.config/systemd/user/koala-machine.service && echo unit-kept || echo unit-gone')).trim();
    return /^(inactive|failed|unknown)/.test(state) ? state : waiting(state.trim().split('\n').join(', '));
  }, gone);
  assert.match(stopped, /token-gone/, stopped);
  assert.match(stopped, /unit-gone/, stopped);
  const projectsAfter = await (await onInstance('/api/projects')).json() as { id: string; executionTarget?: { deviceId?: string } }[];
  assert.ok(!projectsAfter.some((project) => project.executionTarget?.deviceId === machine.id), 'the machine\'s project is still there');
  const k3sLeft = (await inVm(machineVm, 'for f in /usr/local/bin/k3s /etc/sudoers.d/koala-k3s /etc/koala/machine-k3s /etc/systemd/system/k3s.service.d/koala-firewall.conf; do sudo test -e $f && echo $f; done; true')).trim();
  assert.equal(k3sLeft, '', `the machine kept ${k3sLeft}`);
  assert.equal(await clusterOf(), undefined, 'the instance still lists the removed machine\'s cluster');
  await until('the instance dropping the removed machine from the mesh, so it no longer reaches the machine gateway', async () => ((await reaches(machineVm, instanceMeshIp!, GATEWAY_PORT)) ? waiting(`the machine still reaches ${instanceMeshIp}:${GATEWAY_PORT}`) : true), gone);
  console.log(`  ${machineMeshIp} is off the mesh, its agent ${stopped.split('\n').join(', ')}, its project gone`);

  const kubectl = (args: string) => inVm(instanceVm, `sudo k3s kubectl -n nowrinkles ${args}`);
  const jobEnds = async (name: string, outcome: 'complete' | 'failed') => {
    const conditions = await until(`the self-upgrade job ${name} ending`, async () => {
      const found = (await kubectl(`get job ${name} -o jsonpath='{.status.conditions[?(@.status=="True")].type}'`)).toLowerCase();
      return found.includes('complete') || found.includes('failed') ? found : waiting(`its conditions are ${found || 'none yet'}`);
    }, gone);
    assert.ok(conditions.includes(outcome), `the self-upgrade job ${name} ended ${conditions}, not ${outcome}`);
  };
  const upgradeOnce = async (name: string, outcome: 'complete' | 'failed') => {
    await kubectl(`create job --from=cronjob/instance-self-upgrade ${name}`);
    await jobEnds(name, outcome);
  };
  const reported = async () => {
    const { instance } = await (await asOwner('/api/instances/mine')).json() as { instance: { status: string; detail?: string } };
    return { status: instance.status, detail: instance.detail };
  };
  const backendImage = async () => (await kubectl("get deploy instance-backend -o jsonpath='{.spec.template.spec.containers[0].image}'")).trim();
  const answers = async () => (await fetch(`${INSTANCE_URL}/api/auth/sign-in`)).status === 200;
  const watchAvailability = () => {
    const misses: string[] = [];
    let checks = 0;
    const timer = setInterval(() => {
      checks += 1;
      void fetch(`${INSTANCE_URL}/api/auth/sign-in`, { signal: AbortSignal.timeout(5000) })
        .then((response) => { if (response.status !== 200) misses.push(`${new Date().toISOString()} ${response.status}`); })
        .catch((err: Error) => { misses.push(`${new Date().toISOString()} ${err.message}`); });
    }, 3000);
    return () => { clearInterval(timer); return { checks, misses }; };
  };

  step('the instance checks root for the version it should run, and reports in');
  await upgradeOnce('self-upgrade-now', 'complete');
  assert.deepEqual(await reported(), { status: 'ready', detail: UPGRADE_WORDS.running(TAG) }, 'root did not hear the instance check in');

  step('root publishes a new release, and the instance upgrades itself to it without dropping a request');
  run('docker', ['tag', IMAGE, '127.0.0.1:5000/nowrinkles/app:upgrade-ok']);
  run('docker', ['push', '-q', '127.0.0.1:5000/nowrinkles/app:upgrade-ok']);
  await startRoot('upgrade-ok');
  await inVm(instanceVm, `echo ${Buffer.from(INSIDE_WATCH).toString('base64')} | base64 -d > /tmp/inside-watch.sh && setsid sh /tmp/inside-watch.sh > /tmp/inside.log 2>&1 < /dev/null &`);
  const duringGood = watchAvailability();
  await upgradeOnce('upgrade-to-ok', 'complete');
  const good = duringGood();
  await inVm(instanceVm, 'pkill -F /tmp/inside.pid');
  console.log(`  answered ${good.checks - good.misses.length} of ${good.checks} checks while upgrading`);
  if (good.misses.length > 0) {
    const inside = (await inVm(instanceVm, 'cat /tmp/inside.log')).trim().split('\n');
    const odd = inside.filter((line) => { const [, code, seconds] = line.split(' '); return code !== '200' || Number(seconds) > 1; });
    console.log(`  from inside the machine, every half second: ${inside.length} asked, ${odd.length} slow or failed:\n    ${odd.join('\n    ')}`);
    console.log(`  what Kubernetes did:\n    ${(await kubectl('get events --sort-by=.lastTimestamp -o custom-columns=AT:.lastTimestamp,OBJECT:.involvedObject.name,REASON:.reason,MESSAGE:.message')).trim().split('\n').slice(-40).join('\n    ')}`);
    console.log(`  the new backend's start:\n    ${(await kubectl('logs deploy/instance-backend -c backend --timestamps')).trim().split('\n').slice(0, 40).join('\n    ')}`);
  }
  assert.deepEqual(good.misses, [], 'the instance stopped answering during a good upgrade');
  assert.deepEqual(await reported(), { status: 'ready', detail: UPGRADE_WORDS.upgraded('upgrade-ok') });
  assert.match(await backendImage(), /:upgrade-ok$/, 'the backend is not running the new release');
  assert.ok(await until('the upgraded instance answering', async () => ((await answers()) ? true : waiting('/api/auth/sign-in does not answer 200 yet')), gone));

  step('root publishes a broken release, and the instance rolls itself back without dropping a request, telling root it failed');
  execFileSync('docker', ['build', '-q', '-t', '127.0.0.1:5000/nowrinkles/app:upgrade-broken', '-'], {
    input: `FROM ${IMAGE}\nENTRYPOINT ["sh", "-c", "echo broken on purpose; exit 1"]\n`, cwd: REPO, stdio: ['pipe', 'ignore', 'pipe'],
  });
  run('docker', ['push', '-q', '127.0.0.1:5000/nowrinkles/app:upgrade-broken']);
  await startRoot('upgrade-broken');
  const duringBroken = watchAvailability();
  await upgradeOnce('upgrade-to-broken', 'failed');
  const broken = duringBroken();
  console.log(`  answered ${broken.checks - broken.misses.length} of ${broken.checks} checks while the broken release failed and was rolled back`);
  assert.deepEqual(broken.misses, [], 'the instance stopped answering while a broken release failed');
  const brokenReport = await reported();
  assert.equal(brokenReport.status, 'failed');
  assert.ok(brokenReport.detail?.startsWith(`${UPGRADE_WORDS.rolledBack('upgrade-broken', 'upgrade-ok')}: `), `root heard ${brokenReport.detail}`);
  assert.match(await backendImage(), /:upgrade-ok$/, 'the rollback did not put the working release back');
  assert.ok(await until('the rolled-back instance answering', async () => ((await answers()) ? true : waiting('/api/auth/sign-in does not answer 200 yet')), gone));
  const history = await inVm(instanceVm, '~/.local/share/koala/bin/helm history instance -n nowrinkles --kubeconfig /etc/rancher/k3s/k3s.yaml');
  console.log(`  ${history.trim().split('\n').slice(-3).join('\n  ')}`);

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
