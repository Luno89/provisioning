import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDisposableVm, findFreePort, type DisposableVm } from './lib/disposable-vm.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
const STAMP = Date.now().toString(36);
const MESH = 'http://10.0.2.2:8080';
const MESH_USER = `machine-probe-${STAMP}`;
const PERSON = 'person';
const PERSON_UID = 1500;
const POD_IMAGE = 'alpine:3.20';
const GET = 'wget -qO- --no-check-certificate';

interface Pin { name: string; version: string; sha256?: string; source?: string; sha256s?: Record<string, string> }
const pins = (JSON.parse(readFileSync(join(REPO, 'dependencies.pins.json'), 'utf8')) as { components: Pin[] }).components;
const pin = (name: string): Pin => {
  const found = pins.find((component) => component.name === name);
  if (!found) throw new Error(`dependencies.pins.json has no ${name}`);
  return found;
};
const K3S = pin('k3s');
const TAILSCALE = pin('tailscale');

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const headscale = (...args: string[]) => run('docker', ['exec', 'provisioning-headscale', 'headscale', ...args]);
const step = (message: string) => console.log(`\n▶ ${message}`);

function inVm(vm: DisposableVm, command: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('ssh', ['-i', vm.privateKeyPath, '-p', String(vm.port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', `${vm.username}@${vm.host}`, `bash -lc ${JSON.stringify(command)}`]);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => (code === 0 ? resolveP(out) : rejectP(new Error(`exited ${code} running: ${command}\n${out.slice(-2000)}`))));
  });
}
const succeeds = (vm: DisposableVm, command: string): Promise<boolean> => inVm(vm, command).then(() => true, () => false);
const asPerson = (command: string) => `sudo -u ${PERSON} -H bash -c ${JSON.stringify(command)}`;

const tailscaleInstall = (): string => {
  const sha = TAILSCALE.sha256s?.['linux-amd64'];
  return [
    'set -e',
    `curl -fsSL https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE.version}_amd64.tgz -o /tmp/ts.tgz`,
    `echo "${sha}  /tmp/ts.tgz" | sha256sum -c --quiet -`,
    'tar -xzf /tmp/ts.tgz -C /tmp',
    `cd /tmp/tailscale_${TAILSCALE.version}_amd64`,
    'sudo install -m 755 tailscale /usr/bin/tailscale && sudo install -m 755 tailscaled /usr/sbin/tailscaled',
    'sudo install -m 644 systemd/tailscaled.service /etc/systemd/system/ && sudo install -m 644 systemd/tailscaled.defaults /etc/default/tailscaled',
    'sudo systemctl daemon-reload && sudo systemctl enable --now tailscaled',
  ].join(' && ');
};

const k3sConfig = (meshIp: string): string => [
  'disable:', '  - traefik', '  - servicelb',
  'tls-san:', `  - ${meshIp}`,
  'write-kubeconfig-mode: "0640"',
  `write-kubeconfig-group: ${PERSON}`,
].join('\n');

const k3sInstall = (meshIp: string): string => [
  'set -e',
  'sudo mkdir -p /etc/rancher/k3s',
  `echo ${Buffer.from(`${k3sConfig(meshIp)}\n`).toString('base64')} | base64 -d | sudo tee /etc/rancher/k3s/config.yaml >/dev/null`,
  `curl -fsSL ${K3S.source} -o /tmp/k3s-install.sh`,
  `echo "${K3S.sha256}  /tmp/k3s-install.sh" | sha256sum -c --quiet -`,
  `sudo INSTALL_K3S_VERSION=${JSON.stringify(K3S.version)} INSTALL_K3S_SKIP_START=true INSTALL_K3S_SKIP_ENABLE=true sh /tmp/k3s-install.sh`,
].join(' && ');

const START_STOP_RULE = `${PERSON} ALL=(root) NOPASSWD: /usr/bin/systemctl start k3s, /usr/bin/systemctl stop k3s, /usr/local/bin/k3s-killall.sh`;

const FIREWALL = [
  'sudo iptables -N KOALA-MACHINE',
  'sudo iptables -A KOALA-MACHINE -i lo -j RETURN',
  'sudo iptables -A KOALA-MACHINE -i tailscale0 -j RETURN',
  'sudo iptables -A KOALA-MACHINE -s 10.42.0.0/16 -j RETURN',
  'sudo iptables -A KOALA-MACHINE -j DROP',
  'sudo iptables -I INPUT -p tcp -m multiport --dports 6443,10250 -j KOALA-MACHINE',
].join(' && ');

const kubectlAsPerson = (args: string) => asPerson(`KUBECONFIG=/etc/rancher/k3s/k3s.yaml k3s kubectl ${args}`);

const DNS_READY = `{.items[0].status.conditions[?(@.type=="Ready")].status} {.items[0].status.conditions[?(@.type=="Ready")].lastTransitionTime}`;

async function nodeReady(vm: DisposableVm, since: number): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    const dns = await inVm(vm, kubectlAsPerson(`-n kube-system get pod -l k8s-app=kube-dns -o jsonpath='${DNS_READY}'`)).catch(() => '');
    const [status, at] = dns.trim().split(' ');
    if (status === 'True' && at && Date.parse(at) / 1000 >= since && await succeeds(vm, kubectlAsPerson('wait --for=condition=Ready node --all --timeout=10s'))) return;
    if (tries > 120) throw new Error(`k3s on ${vm.host}:${vm.port} never answered DNS after its start:\n${await inVm(vm, 'sudo journalctl -u k3s --no-pager | tail -40').catch(() => '')}`);
    await new Promise((done) => setTimeout(done, 2000));
  }
}

interface PodShape { runAs?: number; folder?: string }

async function podSays(vm: DisposableVm, name: string, script: string, shape: PodShape = {}): Promise<string> {
  const manifest = JSON.stringify({
    apiVersion: 'v1', kind: 'Pod', metadata: { name },
    spec: {
      restartPolicy: 'Never',
      ...(shape.runAs ? { securityContext: { runAsUser: shape.runAs, runAsGroup: shape.runAs } } : {}),
      ...(shape.folder ? { volumes: [{ name: 'work', hostPath: { path: shape.folder, type: 'Directory' } }] } : {}),
      containers: [{ name, image: POD_IMAGE, command: ['sh', '-c', script], ...(shape.folder ? { volumeMounts: [{ name: 'work', mountPath: '/work' }] } : {}) }],
    },
  });
  await inVm(vm, `echo ${Buffer.from(manifest).toString('base64')} | base64 -d | ${kubectlAsPerson('apply -f -')}`);
  for (let tries = 0; tries < 90; tries += 1) {
    const phase = (await inVm(vm, kubectlAsPerson(`get pod ${name} -o jsonpath={.status.phase}`))).trim();
    if (phase === 'Succeeded' || phase === 'Failed') {
      const logs = await inVm(vm, kubectlAsPerson(`logs ${name}`));
      if (phase === 'Succeeded') await inVm(vm, kubectlAsPerson(`delete pod ${name} --wait=false`));
      if (phase === 'Failed') throw new Error(`pod ${name} failed:\n${logs}\n── the pod ──\n${await inVm(vm, kubectlAsPerson(`get pod ${name} -o jsonpath={.status.containerStatuses}`)).catch(() => '')}`);
      return logs;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error(`pod ${name} never finished:\n${await inVm(vm, kubectlAsPerson(`describe pod ${name}`))}`);
}

async function startsK3s(vm: DisposableVm): Promise<void> {
  const since = Number((await inVm(vm, 'date -u +%s')).trim()) - 1;
  try {
    await inVm(vm, asPerson('sudo -n systemctl start k3s'));
  } catch (err) {
    throw new Error(`${(err as Error).message}\n── k3s said ──\n${await inVm(vm, 'sudo journalctl -u k3s --no-pager | tail -30').catch(() => '')}`);
  }
  await nodeReady(vm, since);
}

const vms: DisposableVm[] = [];
let meshUserId: string | undefined;

async function teardown(): Promise<void> {
  try {
    const nodes = JSON.parse(headscale('nodes', 'list', '-o', 'json')) as Array<{ id: number; user?: { name?: string } }>;
    for (const node of nodes.filter((n) => n.user?.name === MESH_USER)) headscale('nodes', 'delete', '-i', String(node.id), '--force');
  } catch { /* nothing joined */ }
  if (meshUserId) try { headscale('users', 'destroy', '--identifier', meshUserId, '--force'); } catch { /* gone */ }
  for (const vm of vms) await vm.destroy();
}

async function machine(name: string, key: string): Promise<{ vm: DisposableVm; meshIp: string }> {
  const vm = await createDisposableVm(`${name}-${STAMP}`, { memoryMB: 4096, cpus: 2, diskGB: 20 });
  vms.push(vm);
  await inVm(vm, `sudo useradd -m -u ${PERSON_UID} -s /bin/bash ${PERSON}`);
  await inVm(vm, tailscaleInstall());
  await inVm(vm, `sudo tailscale up --login-server=${MESH} --auth-key=${key} --hostname=${name}-${STAMP} --accept-dns=false`);
  const meshIp = (await inVm(vm, 'tailscale ip -4 | head -n1')).trim();
  await inVm(vm, k3sInstall(meshIp));
  console.log(`  ${name}: on the mesh as ${meshIp}, k3s ${K3S.version} installed and not running`);
  return { vm, meshIp };
}

async function main(): Promise<void> {
  step('two machines of one person join the mesh, each with k3s installed but neither started nor enabled');
  headscale('users', 'create', MESH_USER);
  meshUserId = String((JSON.parse(headscale('users', 'list', '-o', 'json')) as Array<{ id: number; name: string }>).find((u) => u.name === MESH_USER)?.id);
  const key = (JSON.parse(headscale('preauthkeys', 'create', '--user', meshUserId, '--reusable', '--expiration', '1h', '-o', 'json')) as { key: string }).key;
  const [a, b] = await Promise.all([machine('probe-a', key), machine('probe-b', key)]);
  for (const { vm } of [a, b]) {
    assert.equal((await inVm(vm, 'systemctl is-enabled k3s || true')).trim(), 'disabled', 'k3s was enabled at install');
    assert.equal((await inVm(vm, 'systemctl is-active k3s || true')).trim(), 'inactive', 'k3s was started at install');
  }

  step('1. the person starts and stops k3s through one narrow rule, with no password and no other root');
  await inVm(b.vm, `echo ${JSON.stringify(START_STOP_RULE)} | sudo tee /etc/sudoers.d/koala-k3s >/dev/null && sudo chmod 440 /etc/sudoers.d/koala-k3s && sudo visudo -cf /etc/sudoers.d/koala-k3s`);
  assert.equal(await succeeds(b.vm, asPerson('sudo -n true')), false, 'the person could run anything as root');
  assert.equal(await succeeds(b.vm, asPerson('sudo -n systemctl restart sshd')), false, 'the rule let the person touch another service');
  await startsK3s(b.vm);
  console.log('  started by the person; its kubeconfig is readable by the person without sudo, and the node is Ready');
  await inVm(b.vm, asPerson('sudo -n systemctl stop k3s && sudo -n /usr/local/bin/k3s-killall.sh >/dev/null'));
  assert.equal((await inVm(b.vm, 'pgrep -c -x containerd-shim || true')).trim(), '0', 'pods\' containers kept running after the stop');
  assert.equal((await inVm(b.vm, 'systemctl is-active k3s || true')).trim(), 'inactive');
  console.log('  stopped by the person: no containerd shim is left running');
  await startsK3s(b.vm);
  console.log('  started again; the node is Ready');

  step('2. the cluster answers only on loopback, the mesh and its own pods, never on the machine\'s network');
  const lanPort = await findFreePort();
  await b.vm.forward(lanPort, 6443);
  const fromLan = () => { try { run('curl', ['-sk', '--max-time', '8', '-o', '/dev/null', '-w', '%{http_code}', `https://127.0.0.1:${lanPort}/version`]); return true; } catch { return false; } };
  assert.equal(fromLan(), true, 'the API did not answer on the machine\'s network before the firewall, so the check proves nothing');
  await inVm(b.vm, FIREWALL);
  assert.equal(fromLan(), false, 'the API still answers on the machine\'s network');
  for (const port of [80, 443]) assert.equal(await succeeds(b.vm, `sudo ss -ltnH 'sport = :${port}' | grep -q .`), false, `something listens on ${port}`);
  const own = await podSays(b.vm, 'own-api', `${GET} --header "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" https://kubernetes.default.svc/version`);
  assert.match(own, /gitVersion/, 'a pod on the machine no longer reaches its own cluster\'s API');
  console.log('  closed from the machine\'s network, nothing on 80/443, and its own pods still reach its API');

  step('3. a pod on one machine\'s cluster reaches the other machine\'s Kubernetes API over the mesh');
  await inVm(a.vm, `printf '%s\\n' ${JSON.stringify(START_STOP_RULE)} | sudo tee /etc/sudoers.d/koala-k3s >/dev/null && sudo chmod 440 /etc/sudoers.d/koala-k3s`);
  await startsK3s(a.vm);
  await inVm(b.vm, kubectlAsPerson('create serviceaccount koala-probe') + ' && ' + kubectlAsPerson('create clusterrolebinding koala-probe --clusterrole=view --serviceaccount=default:koala-probe'));
  const token = (await inVm(b.vm, kubectlAsPerson('create token koala-probe --duration=1h'))).trim();
  const across = await podSays(a.vm, 'across-mesh', `${GET} --header "Authorization: Bearer ${token}" https://${b.meshIp}:6443/api/v1/namespaces/kube-system/pods`);
  assert.match(across, /"kind":\s*"PodList"/, `a pod on ${a.meshIp} did not list ${b.meshIp}'s pods`);
  const certNames = await inVm(a.vm, `echo | openssl s_client -connect ${b.meshIp}:6443 2>/dev/null | openssl x509 -noout -ext subjectAltName`);
  assert.ok(certNames.includes(b.meshIp), `${b.meshIp} is not on the API's certificate: ${certNames}`);
  console.log(`  a pod on ${a.meshIp} listed ${b.meshIp}'s pods with a service account token, and the certificate names the mesh address`);

  step('4. a workspace pod mounts only the person\'s folder, as the person, and what it writes is theirs');
  await inVm(b.vm, asPerson('mkdir -p ~/koala/project && echo theirs > ~/koala/project/README && echo secret > ~/outside.txt'));
  const folder = `/home/${PERSON}/koala/project`;
  const said = await podSays(b.vm, 'as-person', 'id -u; id -g; cat /work/README; echo made > /work/from-pod.txt; ls /work; ls /home 2>&1 || true', { runAs: PERSON_UID, folder });
  assert.match(said, new RegExp(`^${PERSON_UID}\\n${PERSON_UID}\\ntheirs`), `the pod did not run as the person or could not read their folder:\n${said}`);
  assert.equal((await inVm(b.vm, `stat -c '%U:%G' ${folder}/from-pod.txt`)).trim(), `${PERSON}:${PERSON}`, 'the file the pod wrote is not the person\'s');
  assert.ok(!said.includes('outside.txt'), 'the pod saw beyond the folder');
  console.log('  the pod ran as the person, read and wrote their folder, and the file it made is theirs');
}

main()
  .then(async () => { await teardown(); console.log('\nmachine probe live — PASS'); process.exit(0); })
  .catch(async (err) => {
    console.error(err);
    if (process.env.PROBE_KEEP === '1') {
      for (const vm of vms) console.error(`kept: ssh -i ${vm.privateKeyPath} -p ${vm.port} ${vm.username}@${vm.host}`);
      return;
    }
    await teardown();
    process.exit(1);
  });
