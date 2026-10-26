import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDisposableVm, findFreePort, type DisposableVm } from './lib/disposable-vm.js';
import { buildAppImage } from './lib/gate-runs.js';
import { endsWith, failedUpgradeReports, imageTagOf, inFlightRefusal, unsignedRefusal, labDnsmasq, labHostsLine, noted, revisionRunning, upgradeReports, type Report } from './lib/release-lab.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
const PREVIOUS_REF = process.env.RELEASE_LIVE_PREVIOUS ?? 'v2026.10.23';
const DOMAIN = 'koala.internal';
const ROOT_LAN = '10.77.0.1';
const INSTANCE_LAN = '10.77.0.2';
const ROOT_PORT = 3001;
const ROOT_URL = `http://app.${DOMAIN}:${ROOT_PORT}`;
const TLS_PORT = 18443;
const IMAGE_REPO = 'nowrinkles/app';
const REPO_DIR = '/opt/nowrinkles';
const ORIGIN = '/opt/nowrinkles-origin.git';
const UPDATE_SH = '/opt/koala-release/update.sh';
const NAMESPACE = 'nowrinkles';
const STAMP = Date.now().toString(36);
const NAME = `rl${STAMP}`;
const EMAIL = `release-live-${STAMP}@example.com`;
const PASSWORD = randomBytes(18).toString('base64url');
const CANDIDATE_REF = 'v2099.12.31';
const UNSIGNED_REF = 'v2099.12.30';
const SIGNERS = '/etc/koala/release-signers';
const MANIFESTS = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json';

const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
const step = (message: string) => console.log(`\n▶ ${message}`);
const note = (message: string) => console.log(`  ${message}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const minutes = (since: number) => `${((Date.now() - since) / 60_000).toFixed(1)} min`;

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
    if (tries > 0 && tries % 24 === 0) note(`still waiting for ${what}${last ? ` (${last.slice(0, 200)})` : ''}`);
    await sleep(5000);
  }
}

const sshArgs = (vm: DisposableVm) => ['-i', vm.privateKeyPath, '-p', String(vm.port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ServerAliveInterval=30', `${vm.username}@${vm.host}`];

function inVm(vm: DisposableVm, command: string, stream = false, input?: NodeJS.ReadableStream): Promise<{ code: number; out: string }> {
  return new Promise((resolveP) => {
    const child = spawn('ssh', [...sshArgs(vm), command], { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (input) input.pipe(child.stdin!);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; if (stream) process.stdout.write(`    ${String(chunk).replace(/\n(?!$)/g, '\n    ')}`); });
    child.stderr.on('data', (chunk) => { out += chunk; if (stream) process.stderr.write(`    ${chunk}`); });
    child.on('close', (code) => resolveP({ code: code ?? 1, out }));
  });
}

async function sh(vm: DisposableVm, command: string, stream = false): Promise<string> {
  const { code, out } = await inVm(vm, command, stream);
  if (code !== 0) throw new Error(`exited ${code} running: ${command}\n${out.slice(-3000)}`);
  return out;
}

interface Answer { status: number; body: string; headers: Record<string, string> }
interface UpdatesSeen { auto: boolean; picked?: string; running?: string; target: string; checking?: string; releases: { imageTag: string; current: boolean; choosable: boolean }[] }

let work = '';
let root: DisposableVm | undefined;
let instance: DisposableVm | undefined;
let previousTag = '';

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

const json = <T>(answer: Answer): T => JSON.parse(answer.body) as T;

function buildImage(commit: string, label: string): string {
  buildAppImage(REPO, commit, (line) => note(`${label}: ${line}`));
  return imageTagOf(commit);
}

const SANDBOX_PROCEDURE = (id: string) => ({ schema: 2, id, version: '1', name: 'Release rehearsal', describe: 'runs code in a sandbox', budget: {}, start: 'provision', cleanup: 'release',
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
  groups: [] });

async function teardown(): Promise<void> {
  await instance?.destroy();
  await root?.destroy();
  if (previousTag) try { run('docker', ['rmi', `${IMAGE_REPO}:${previousTag}`]); } catch { /* kept or gone */ }
  if (work) rmSync(work, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const begun = Date.now();
  work = mkdtempSync(join(tmpdir(), 'release-live-'));
  const dirty = run('git', ['status', '--porcelain']).trim().split('\n').filter((line) => line && !/last-passed\.json|LAST-PASSED\.md/.test(line));
  if (dirty.length) note(`uncommitted changes are not part of the candidate: ${dirty.join(', ')}`);
  const candidate = run('git', ['rev-parse', 'HEAD']).trim();
  const previous = run('git', ['rev-parse', `${PREVIOUS_REF}^{commit}`]).trim();
  assert.notEqual(candidate, previous, `the candidate is ${PREVIOUS_REF} itself; commit something to rehearse an update`);
  const candidateTag = imageTagOf(candidate);

  step(`the image is built at ${PREVIOUS_REF} (${imageTagOf(previous)}) and at the candidate (${candidateTag})`);
  previousTag = buildImage(previous, PREVIOUS_REF);
  buildImage(candidate, 'candidate');

  step('root: a disposable VM on a lab network, bootstrapped by the real bootstrap.sh in lab mode');
  const lanPort = await findFreePort();
  root = await createDisposableVm('release-root', { memoryMB: 12288, cpus: 4, diskGB: 80, forwards: [{ host: TLS_PORT, guest: 443 }], lan: { listen: lanPort, address: `${ROOT_LAN}/24` } });
  await sh(root, [
    `echo '${labHostsLine(DOMAIN, ROOT_LAN)}' | sudo tee -a /etc/hosts >/dev/null`,
    'sudo mkdir -p /etc/dnsmasq.d',
    `printf '%s' '${labDnsmasq(DOMAIN, ROOT_LAN)}' | sudo tee /etc/dnsmasq.d/koala-lab.conf >/dev/null`,
    'sudo apt-get update -qq >/dev/null',
    'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq dnsmasq git >/dev/null',
    'sudo systemctl restart dnsmasq',
    'sudo ufw allow in on lan0 to any port 53 >/dev/null',
    `sudo ufw allow in on lan0 to any port ${ROOT_PORT} proto tcp >/dev/null`,
    `sudo git init -q --bare ${ORIGIN} && sudo chown -R ubuntu ${ORIGIN} && sudo git config --system --add safe.directory ${ORIGIN}`,
  ].join(' && '));
  note(`lab DNS answers *.${DOMAIN} with ${ROOT_LAN}; root's API is reachable on the lan at ${ROOT_URL}`);
  const labKey = join(work, 'release-key');
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'the release rehearsal\'s throwaway key', '-f', labKey]);
  const signing = ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${labKey}`];
  const previousMessage = run('git', ['tag', '--list', '--format=%(contents:subject)%0a%0a%(contents:body)', PREVIOUS_REF]).trim();
  const tagClone = join(work, 'tags.git');
  run('git', ['clone', '-q', '--bare', '--shared', REPO, tagClone]);
  const inTags = (args: string[], env: Record<string, string> = {}) => run('git', ['-C', tagClone, ...args], env);
  inTags(['tag', '-d', PREVIOUS_REF]);
  inTags([...signing, 'tag', '-s', PREVIOUS_REF, previous, '-m', previousMessage]);
  inTags([...signing, 'tag', '-s', CANDIDATE_REF, candidate, '-m', `${CANDIDATE_REF}\n\nShipped and released from ${candidateTag} after ${PREVIOUS_REF}: the release rehearsal's own tag, signed by its throwaway key.`]);
  inTags(['tag', '-a', UNSIGNED_REF, candidate, '-m', `${UNSIGNED_REF}\n\nShipped and released from ${candidateTag} after ${PREVIOUS_REF}: signed by nobody.`],
    { GIT_COMMITTER_DATE: new Date(Date.now() - 86_400_000).toISOString() });
  inTags(['push', '-q', '--force', `ssh://ubuntu@127.0.0.1:${root.port}${ORIGIN}`, `${previous}:refs/heads/previous`, `${candidate}:refs/heads/candidate`,
    ...[PREVIOUS_REF, CANDIDATE_REF, UNSIGNED_REF].map((name) => `refs/tags/${name}:refs/tags/${name}`)],
    { GIT_SSH_COMMAND: `ssh -i ${root.privateKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR` });
  await sh(root, `sudo git clone -q ${ORIGIN} ${REPO_DIR} && sudo git -C ${REPO_DIR} checkout -q --detach ${candidate} && sudo mkdir -p $(dirname ${UPDATE_SH}) && sudo cp ${REPO_DIR}/scripts/root-node/update.sh ${REPO_DIR}/scripts/root-node/cdktf-bindings.sh ${REPO_DIR}/scripts/root-node/verify-release.sh $(dirname ${UPDATE_SH})/`);
  const signer = Buffer.from(`koala-release namespaces="git" ${readFileSync(`${labKey}.pub`, 'utf8').trim()}\n`).toString('base64');
  await sh(root, `sudo mkdir -p $(dirname ${SIGNERS}) && echo ${signer} | base64 -d | sudo tee ${SIGNERS} >/dev/null`);
  note(`${REPO_DIR} is a clone of this repository with ${PREVIOUS_REF}, the candidate as ${CANDIDATE_REF} and ${UNSIGNED_REF}; root trusts only the rehearsal's throwaway key, which signed all but ${UNSIGNED_REF}; the candidate's update.sh is kept at ${UPDATE_SH}`);
  const bootstrapped = Date.now();
  await sh(root, `sudo env ROOT_TLS=internal DOMAIN=${DOMAIN} PUBLIC_URL=${ROOT_URL} bash ${REPO_DIR}/scripts/root-node/bootstrap.sh`, true);
  note(`bootstrap.sh finished in ${minutes(bootstrapped)}`);
  writeFileSync(join(work, 'ca.crt'), await sh(root, 'sudo cat /usr/local/share/ca-certificates/koala-lab.crt'));
  const hardened = await sh(root, [
    'sysctl -n net.ipv4.conf.all.accept_redirects kernel.kptr_restrict kernel.dmesg_restrict fs.protected_symlinks',
    'sudo sshd -T | grep -E "^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|allowusers) "',
    'sudo docker info --format "{{.LoggingDriver}} {{.LiveRestoreEnabled}} {{json .SecurityOptions}}"',
    'apt-config dump | grep -E "^APT::Periodic::Unattended-Upgrade "',
    'sudo stat -c %a /var/lib/rancher/k3s-provisioning-lunorica/kubeconfig.yaml',
    'test -d /var/log/journal && echo journal-kept',
  ].join(' && '));
  for (const line of ['0\n2\n1\n1', 'permitrootlogin no', 'passwordauthentication no', 'kbdinteractiveauthentication no', 'allowusers ubuntu', 'local true', 'no-new-privileges', 'APT::Periodic::Unattended-Upgrade "1";', '\n600\n', 'journal-kept']) {
    assert.ok(hardened.includes(line), `root's hardening is missing ${JSON.stringify(line)}:\n${hardened}`);
  }
  note('root keeps its hardening: no redirects, kernel pointers and dmesg hidden, SSH by key for ubuntu only, Docker without new privileges and with rotating logs, daily security updates, a private kubeconfig and a kept journal');

  step(`root's registry is given the ${PREVIOUS_REF} image, and release-watch.sh, as npm run release runs it over SSH, moves root onto ${PREVIOUS_REF} with the real update.sh`);
  const saved = spawn('docker', ['save', `${IMAGE_REPO}:${previousTag}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const loaded = await inVm(root, 'sudo docker load -q', false, saved.stdout);
  assert.equal(loaded.code, 0, `the image did not load on root: ${loaded.out.slice(-500)}`);
  await sh(root, `sudo docker tag ${IMAGE_REPO}:${previousTag} 127.0.0.1:5000/${IMAGE_REPO}:${previousTag} && sudo docker push -q 127.0.0.1:5000/${IMAGE_REPO}:${previousTag} >/dev/null`);
  const toPrevious = Date.now();
  await sh(root, `sudo bash ${REPO_DIR}/scripts/root-node/release-watch.sh ${PREVIOUS_REF}`, true);
  note(`release-watch.sh ${PREVIOUS_REF} took ${minutes(toPrevious)}`);
  const rootHead = async () => (await sh(root!, `sudo git -C ${REPO_DIR} rev-parse HEAD`)).trim();
  const rootReleaseTag = async () => (await sh(root!, `sudo grep '^INSTANCE_IMAGE_TAG=' ${REPO_DIR}/apps/backend/.env | cut -d= -f2-`)).trim();
  assert.equal(await rootHead(), previous, 'root is not on the previous release');
  assert.equal(await rootReleaseTag(), previousTag, 'root does not offer instances the previous image');
  assert.equal((await sh(root, 'systemctl is-active nowrinkles')).trim(), 'active');
  const rootAnswers = async () => https(`app.${DOMAIN}`, '/api/identity/keys').status === 200;
  await until('root answering through its Caddy', async () => ((await rootAnswers()) ? true : undefined));
  note(`https://app.${DOMAIN} answers through Caddy with a certificate from its own authority`);

  step('the first account signs up on root with the setup code bootstrap made, and becomes its admin');
  const setupCode = (await sh(root, `sudo grep '^ADMIN_SETUP_CODE=' ${REPO_DIR}/apps/backend/.env | cut -d= -f2-`)).trim();
  assert.match(setupCode, /^[0-9a-f]{32}$/, 'bootstrap made no setup code');
  const registered = https(`app.${DOMAIN}`, '/api/auth/register', { method: 'POST', body: { email: EMAIL, password: PASSWORD, inviteCode: setupCode } });
  assert.equal(registered.status, 200, registered.body);
  const signedIn = https(`app.${DOMAIN}`, '/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  assert.equal(signedIn.status, 200, signedIn.body);
  const rootCookie = (signedIn.headers['set-cookie'] ?? '').split(';')[0]!;
  assert.match(rootCookie, /^session=/, 'root set no session');
  const asOwner = (path: string, init: { method?: string; body?: unknown } = {}) => https(`app.${DOMAIN}`, path, { ...init, cookie: rootCookie });
  const me = json<{ user?: { isAdmin?: boolean }; isAdmin?: boolean }>(asOwner('/api/auth/me'));
  assert.ok(me.user?.isAdmin ?? me.isAdmin, 'the first account is not the admin');

  step(`an instance: a second VM on the lab network runs root's install command at ${PREVIOUS_REF}`);
  const joined = asOwner('/api/instances/join-tokens', { method: 'POST', body: { name: NAME } });
  assert.equal(joined.status, 200, joined.body);
  const token = json<{ token: string; name: string }>(joined).token;
  const mine = () => json<{ instance: { id: string; status: string; detail?: string; url: string; name?: string } }>(asOwner('/api/instances/mine')).instance;
  const instanceId = mine().id;
  instance = await createDisposableVm('release-instance', { memoryMB: 12288, cpus: 4, diskGB: 60, lan: { connect: lanPort, address: `${INSTANCE_LAN}/24`, nameservers: [ROOT_LAN] } });
  await sh(instance, [
    `echo '${labHostsLine(DOMAIN, ROOT_LAN)}' | sudo tee -a /etc/hosts >/dev/null`,
    `printf '%s' '${await sh(root, 'sudo cat /usr/local/share/ca-certificates/koala-lab.crt')}' | sudo tee /usr/local/share/ca-certificates/koala-lab.crt >/dev/null`,
    'sudo update-ca-certificates >/dev/null',
    `curl -fsS -o /dev/null ${ROOT_URL}/api/identity/keys`,
    `curl -fsS -o /dev/null https://mesh.${DOMAIN}/health`,
  ].join(' && '));
  note('the machine resolves the lab names through root, reaches root on the lan and trusts the lab authority');
  const installed = Date.now();
  await sh(instance, `curl -fsSL ${ROOT_URL}/install.sh | sudo sh -s -- ${token} --yes`, true);
  note(`install.sh took ${minutes(installed)}`);
  assert.equal(mine().status, 'ready', `root sees the instance as ${mine().status}: ${mine().detail}`);
  assert.equal(mine().url, `https://${NAME}.${DOMAIN}`);
  const instanceHost = `${NAME}.${DOMAIN}`;
  await until(`https://${instanceHost} through root's Caddy over the mesh`, async () => (https(instanceHost, '/api/auth/sign-in').status === 200 ? true : undefined));

  const kubectl = (args: string) => sh(instance!, `sudo kubectl -n ${NAMESPACE} ${args}`);
  const helm = (args: string) => sh(instance!, `sudo helm -n ${NAMESPACE} --kubeconfig /etc/rancher/k3s/k3s.yaml ${args}`);
  const registry = (await sh(instance, `sudo kubectl -n ${NAMESPACE} get deploy instance-backend -o jsonpath='{.spec.template.spec.containers[0].image}'`)).trim().replace(/:[^:/]+$/, '');
  note(`the instance pulls ${registry} over the mesh`);

  const handoff = (): string => {
    const go = asOwner('/api/identity/go');
    assert.equal(go.status, 302, `root did not hand the owner over: ${go.status} ${go.body}`);
    const location = go.headers.location ?? '';
    assert.ok(location.startsWith(`https://${instanceHost}/`), `root sent the owner to ${location}`);
    const exchange = https(instanceHost, '/api/auth/handoff', { method: 'POST', body: { token: decodeURIComponent(location.split('token=')[1] ?? '') } });
    assert.equal(exchange.status, 200, `the instance refused the token: ${exchange.body}`);
    return (exchange.headers['set-cookie'] ?? '').split(';')[0]!;
  };
  let cookie = handoff();
  const onInstance = (path: string, init: { method?: string; body?: unknown } = {}) => https(instanceHost, path, { ...init, cookie });
  note('signing in at root lands on the instance');

  step('from the network, root answers only on SSH, HTTP, HTTPS and the two ports the lab opens itself');
  const scanner = Buffer.from([
    'import asyncio, sys',
    'async def probe(port, gate):',
    '    async with gate:',
    '        try:',
    '            _, writer = await asyncio.wait_for(asyncio.open_connection(sys.argv[1], port), 1.0)',
    '            writer.close()',
    '            return port',
    '        except Exception:',
    '            return None',
    'async def scan():',
    '    gate = asyncio.Semaphore(1000)',
    '    found = await asyncio.gather(*(probe(port, gate) for port in range(1, 65536)))',
    '    print(" ".join(str(port) for port in found if port))',
    'asyncio.run(scan())',
  ].join('\n')).toString('base64');
  const answering = (await sh(instance, `echo ${scanner} | base64 -d > /tmp/scan.py && python3 /tmp/scan.py ${ROOT_LAN}`)).trim().split(/\s+/).map(Number);
  assert.deepEqual(answering, [22, 53, 80, 443, ROOT_PORT].sort((a, b) => a - b), `root answers on ${answering.join(', ')}`);
  note(`every TCP port of root scanned from the instance: only ${answering.join(', ')} answer, the cluster's NodePorts, Mongo, Temporal, Headscale and k3s among the closed`);

  step('the instance holds a project with a repository, a deployed app at its address through root, and runs code in a sandbox');
  const project = json<{ id: string }>(onInstance('/api/projects', { method: 'POST', body: { name: 'Rehearsal', giteaRepo: `rehearsal-${NAME}`, createRepo: true } }));
  assert.ok(project.id, 'the project was not made');
  const listing = await until("the project's repository", async () => {
    const answer = onInstance(`/api/projects/${project.id}/files`);
    const entries = answer.status === 200 ? json<{ entries: Array<{ path: string; type: string }> }>(answer).entries.filter((entry) => entry.type === 'file') : [];
    return entries.length ? entries : undefined;
  });
  const repoFile = listing[0]!.path;
  const repositoryWorks = (mark: string) => {
    const opened = json<{ content: string; sha: string }>(onInstance(`/api/projects/${project.id}/files/content?path=${encodeURIComponent(repoFile)}`));
    const wrote = onInstance(`/api/projects/${project.id}/files/content`, { method: 'PUT', body: { path: repoFile, content: `${opened.content}\n${mark}\n`, sha: opened.sha } });
    assert.ok(wrote.status < 300, `the repository took no commit: ${wrote.body}`);
    const read = json<{ content: string }>(onInstance(`/api/projects/${project.id}/files/content?path=${encodeURIComponent(repoFile)}`));
    assert.ok(read.content.endsWith(`${mark}\n`), 'the repository does not hold the commit');
  };
  repositoryWorks(`installed at ${PREVIOUS_REF}`);
  const deployed = onInstance('/api/deployments', { method: 'POST', body: { name: 'books', clusterId: 'provisioning-lunorica', appType: 'audiobookshelf', strategy: 'native' } });
  assert.equal(deployed.status, 202, deployed.body);
  const deploymentId = json<{ id: string }>(deployed).id;
  await until('the app running', async () => {
    const found = json<Array<{ id: string; status: string }>>(onInstance('/api/deployments')).find((entry) => entry.id === deploymentId);
    if (!found) throw new Hopeless('the deployment is gone from the list');
    if (found.status === 'failed') throw new Hopeless('the app failed to deploy');
    return found.status === 'running' ? found : undefined;
  });
  const exposed = onInstance(`/api/deployments/${deploymentId}/expose`, { method: 'POST', body: { mode: 'public' } });
  assert.equal(exposed.status, 200, exposed.body);
  const appHost = `books-${NAME}.${DOMAIN}`;
  assert.equal(json<{ publicExposureUrl: string }>(exposed).publicExposureUrl, `https://${appHost}`);
  const appAnswers = () => until(`the app at https://${appHost}`, async () => (https(appHost, '/').status < 400 ? true : undefined));
  await appAnswers();
  note(`https://${appHost} answers through root's Caddy and the instance's edge`);
  const sandboxedRun = async (id: string) => {
    const saved = onInstance(`/api/procedures/${id}`, { method: 'PUT', body: SANDBOX_PROCEDURE(id) });
    assert.equal(saved.status, 200, saved.body);
    const started = json<{ runId: string }>(onInstance('/api/engine/runs', { method: 'POST', body: { agent: 'executor', message: 'live', procedure: id } }));
    const traces = await until(`the sandboxed run ${id} finishing`, async () => {
      const list = json<{ traces: Array<{ node: string; exit?: string; outputs?: { host?: string }; finish?: { outcome: string } }> }>(onInstance(`/api/engine/runs/${started.runId}/traces`)).traces;
      return list.some((trace) => trace.node === 'cleaned') ? list : undefined;
    });
    assert.equal(traces.find((trace) => trace.node === 'stamp')?.exit, 'ok', 'the code did not run');
    assert.equal(traces.find((trace) => trace.node === 'done')?.finish?.outcome, 'ok', 'the run did not finish ok');
    assert.equal(traces.find((trace) => trace.node === 'stamp')?.outputs?.host, 'workspace', 'the code did not run in a sandbox pod');
  };
  await sandboxedRun('release-live-before');
  note('a sandboxed run finished ok on the instance');

  const watchReports = () => {
    let trail: Report[] = [noted([], mine())[0]!];
    const timer = setInterval(() => { try { trail = noted(trail, mine()); } catch { /* root between answers */ } }, 2000);
    return () => { clearInterval(timer); trail = noted(trail, mine()); return trail; };
  };
  const jobEnds = (name: string) => until(`the self-upgrade job ${name} ending`, async () => {
    const conditions = (await kubectl(`get job ${name} -o jsonpath='{.status.conditions[*].type}'`)).trim();
    return conditions.includes('Complete') || conditions.includes('Failed') ? conditions : undefined;
  });
  const checkIn = async (name: string) => {
    const stop = watchReports();
    await kubectl(`create job --from=cronjob/instance-self-upgrade ${name}`);
    const ended = await jobEnds(name);
    return { ended, trail: stop() };
  };
  const deploymentImages = async () => Object.fromEntries((await kubectl(`get deploy -o jsonpath='{range .items[*]}{.metadata.name}={.spec.template.spec.containers[0].image}{"\\n"}{end}'`)).trim().split('\n').map((line) => line.split('=') as [string, string]));
  const allOn = async (tag: string) => {
    const images = await deploymentImages();
    for (const process of ['backend', 'worker-engine', 'worker-cluster', 'worker-host']) assert.equal(images[`instance-${process}`], `${registry}:${tag}`, `instance-${process} is not on ${tag}`);
    await until(`every deployment ready on ${tag}`, async () => {
      const ready = (await kubectl(`get deploy -o jsonpath='{range .items[*]}{.metadata.name}={.status.readyReplicas}{"\\n"}{end}'`)).trim().split('\n');
      return ready.filter((line) => line.startsWith('instance-')).every((line) => line.endsWith('=1')) ? true : undefined;
    });
  };
  const checkedIn = await checkIn('check-in-before');
  assert.ok(checkedIn.ended.includes('Complete'), `the first check-in did not complete: ${checkedIn.ended}`);
  assert.deepEqual(checkedIn.trail[checkedIn.trail.length - 1], { status: 'ready', detail: `Running ${previousTag}` });
  note(`the instance checked in with root and runs ${previousTag}`);

  step(`root: update.sh ${candidateTag} refuses while a workflow runs on root's Temporal, then updates`);
  const temporal = (await sh(root, "sudo docker ps --filter label=com.docker.compose.service=temporal --format '{{.Names}}'")).trim().split('\n')[0]!;
  assert.ok(temporal, 'root has no Temporal container');
  await sh(root, `sudo docker exec ${temporal} temporal workflow start --address temporal:7233 --task-queue release-live-in-flight --type ReleaseRehearsalInFlight --workflow-id release-live-in-flight >/dev/null`);
  const refused = await inVm(root, `sudo bash ${UPDATE_SH} ${candidate}`);
  assert.notEqual(refused.code, 0, 'update.sh went ahead with a workflow in flight');
  assert.ok(refused.out.includes(inFlightRefusal(1)), `update.sh did not refuse with the expected words:\n${refused.out.slice(-800)}`);
  assert.equal(await rootHead(), previous, 'the refused update moved root');
  note(`refused: ${inFlightRefusal(1)}`);
  await sh(root, `sudo docker exec ${temporal} temporal workflow terminate --address temporal:7233 --workflow-id release-live-in-flight --reason rehearsal >/dev/null`);
  const unsigned = await inVm(root, `sudo bash ${UPDATE_SH} ${UNSIGNED_REF}`);
  assert.notEqual(unsigned.code, 0, `update.sh moved root onto ${UNSIGNED_REF}, which nobody signed`);
  assert.ok(unsigned.out.includes(unsignedRefusal(UNSIGNED_REF, SIGNERS)), `update.sh did not refuse ${UNSIGNED_REF} with the expected words:\n${unsigned.out.slice(-800)}`);
  assert.equal(await rootHead(), previous, 'the refused unsigned tag moved root');
  note(`refused: ${unsignedRefusal(UNSIGNED_REF, SIGNERS)}`);
  const toCandidate = Date.now();
  await sh(root, `sudo bash ${UPDATE_SH} ${CANDIDATE_REF}`, true);
  note(`update.sh ${CANDIDATE_REF} (${candidateTag}) took ${minutes(toCandidate)}`);
  assert.equal(await rootHead(), candidate, 'root is not on the candidate');
  assert.equal(await rootReleaseTag(), candidateTag, 'root does not offer instances the candidate image');
  assert.equal((await sh(root, 'systemctl is-active nowrinkles')).trim(), 'active');
  await until('root answering on the candidate', async () => ((await rootAnswers()) ? true : undefined));
  const tags = JSON.parse(await sh(root, `curl -fsS http://127.0.0.1:5000/v2/${IMAGE_REPO}/tags/list`)) as { tags: string[] };
  assert.ok(tags.tags.includes(candidateTag), `root's registry holds ${tags.tags.join(', ')}, not ${candidateTag}`);
  const registryDigest = (await sh(root, `curl -fsSI -H 'Accept: ${MANIFESTS}' http://127.0.0.1:5000/v2/${IMAGE_REPO}/manifests/${candidateTag} | tr -d '\\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p'`)).trim();
  assert.match(registryDigest, /^sha256:[0-9a-f]{64}$/, `root's registry gives no digest for ${candidateTag}`);
  assert.equal((await sh(root, `sudo grep '^INSTANCE_IMAGE_DIGEST=' ${REPO_DIR}/apps/backend/.env | cut -d= -f2-`)).trim(), registryDigest, 'update.sh did not record the digest it pushed');
  const chartSha = (await sh(root, `sudo sha256sum ${REPO_DIR}/apps/backend/data/instance-charts/${candidateTag}.tgz | cut -d' ' -f1`)).trim();
  const recorded = await until(`root recording ${candidateTag} with its digest and chart`, async () => {
    const found = JSON.parse((await sh(root!, `sudo docker exec $(sudo docker ps --filter label=com.docker.compose.service=mongodb --format '{{.Names}}' | head -1) mongosh --quiet "mongodb://admin:$(sudo grep '^MONGO_ROOT_PASSWORD=' ${REPO_DIR}/.env | cut -d= -f2-)@127.0.0.1:27017/provisioning?authSource=admin" --eval 'JSON.stringify(db.instanceReleases.findOne({ _id: "${candidateTag}" }) ?? {})'`)).trim()) as { digest?: string; chartSha256?: string };
    return found.chartSha256 ? found : undefined;
  });
  assert.deepEqual({ digest: recorded.digest, chartSha256: recorded.chartSha256 }, { digest: registryDigest, chartSha256: chartSha }, 'root does not hand instances the digest and chart sha256 it released');
  note(`root offers ${candidateTag} as ${registryDigest}, its chart as sha256 ${chartSha.slice(0, 12)}…`);
  assert.equal(mine().status, 'ready', 'root lost sight of the instance across the update');
  note(`root runs ${candidateTag}, its registry holds ${tags.tags.join(', ')}`);

  const split = (await sh(root, [
    'systemctl show -p User --value nowrinkles',
    'systemctl is-active nowrinkles-workers',
    "ps -o user= -p $(pgrep -f '[s]rc/index.ts' | head -1)",
    "ps -o user= -p $(pgrep -f '[s]rc/worker-host.ts' | head -1)",
    'sudo -u koala docker ps >/dev/null 2>&1 && echo koala-reaches-docker || echo koala-has-no-docker',
    "curl -s http://127.0.0.1:2019/config/ | head -c 1 | grep -q '{' && echo admin-on-localhost || echo admin-off-localhost",
    `sudo -u koala ${REPO_DIR}/bin/kubectl --kubeconfig /etc/koala/backend-kubeconfig auth can-i get secrets -n gitea || true`,
    `sudo -u koala ${REPO_DIR}/bin/kubectl --kubeconfig /etc/koala/backend-kubeconfig auth can-i get services/kube-prometheus-stack-prometheus:9090 --subresource=proxy -n monitoring || true`,
  ].join(' ; '))).trim().split('\n').map((line) => line.trim());
  assert.deepEqual(split, ['koala', 'active', 'koala', 'root', 'koala-has-no-docker', 'admin-off-localhost', 'no', 'yes'], 'root does not run its backend apart from its workers as it should');
  const routes = `${REPO_DIR}/apps/backend/data/caddy/instances`;
  const routeFile = `${routes}/${(await sh(root, `sudo ls ${routes}`)).split('\n').map((name) => name.trim()).find((name) => name.includes(NAME))}`;
  const since = Number((await sh(root, 'date +%s')).trim());
  await sh(root, `sudo rm ${routeFile}`);
  await until("the backend writing the instance's route again, as koala", async () => ((await sh(root!, `sudo stat -c %U ${routeFile} 2>/dev/null || true`)).trim() === 'koala' ? true : undefined));
  await until("Caddy taking the backend's reload on its admin socket", async () => {
    const loads = (await sh(root!, `sudo grep '"uri":"/load"' /var/log/koala-caddy/caddy.log || true`)).trim().split('\n').filter(Boolean);
    return loads.some((line) => (JSON.parse(line) as { ts: number }).ts >= since) ? true : undefined;
  });
  await until(`https://${instanceHost} through root's Caddy again`, async () => (https(instanceHost, '/api/auth/sign-in').status === 200 ? true : undefined));
  note('root runs its backend as koala, without Docker, beside its workers as root; Caddy\'s admin API is off localhost, the backend reloads it through its socket, and its cluster account reaches the pool\'s Prometheus but not Gitea\'s secrets');

  step(`the instance upgrades itself through the real check-in, from ${previousTag} to ${candidateTag}`);
  const upgraded = await checkIn('upgrade-to-candidate');
  note(`root heard: ${upgraded.trail.map((report) => `${report.status} "${report.detail}"`).join(' → ')}`);
  assert.ok(upgraded.ended.includes('Complete'), `the upgrade job did not complete: ${upgraded.ended}`);
  assert.ok(endsWith(upgraded.trail, upgradeReports(previousTag, candidateTag)), 'root did not hear installing then ready');
  await allOn(candidateTag);
  cookie = handoff();
  await appAnswers();
  repositoryWorks(`upgraded to ${candidateTag}`);
  await sandboxedRun('release-live-upgraded');
  const settled = await checkIn('check-in-upgraded');
  assert.deepEqual(settled.trail[settled.trail.length - 1], { status: 'ready', detail: `Running ${candidateTag}` });
  note(`on ${candidateTag}: sign-in through root, the handoff, the app's address, the repository, a sandboxed run and the check-in work`);

  step(`automatic updates off in the instance's Settings, with root and the instance on ${candidateTag}: root offers a newer release and the instance stays where it is`);
  const updatesAnswer = (answer: Answer): UpdatesSeen => {
    assert.equal(answer.status, 200, `the instance's updates answered ${answer.status}: ${answer.body}`);
    return json<UpdatesSeen>(answer);
  };
  const updatesNow = () => updatesAnswer(onInstance('/api/instance-updates'));
  const changeUpdates = (body: { auto: boolean } | { version: string }) => updatesAnswer(onInstance('/api/instance-updates', { method: 'PUT', body }));
  const seen = updatesNow();
  assert.deepEqual({ auto: seen.auto, running: seen.running, target: seen.target }, { auto: true, running: candidateTag, target: candidateTag }, `the instance's updates read ${JSON.stringify(seen)}`);
  const held = changeUpdates({ auto: false });
  assert.deepEqual({ auto: held.auto, picked: held.picked, checking: held.checking }, { auto: false, picked: candidateTag, checking: undefined });
  const nothing = `nothing-${STAMP}`;
  await sh(root, `sudo sed -i 's|^INSTANCE_IMAGE_TAG=.*|INSTANCE_IMAGE_TAG=${nothing}|' ${REPO_DIR}/apps/backend/.env && sudo systemctl restart nowrinkles`);
  await until('root answering with the newer release', async () => ((await rootAnswers()) ? true : undefined));
  await sh(instance, `curl -fsSL ${ROOT_URL}/api/instances/chart.tgz -o /tmp/current-chart.tgz`);
  await helm('upgrade instance /tmp/current-chart.tgz --reuse-values --set selfUpgrade.timeout=4m --wait --timeout 720h');
  const stayed = await checkIn('check-in-held');
  assert.deepEqual(stayed.trail[stayed.trail.length - 1], { status: 'ready', detail: `Running ${candidateTag}` }, 'the instance moved with automatic updates off');
  const offered = updatesNow().releases.find((row) => row.imageTag === nothing);
  assert.ok(offered?.current && offered.choosable, `the instance is not offered ${nothing}: ${JSON.stringify(offered)}`);
  const person = json<{ people: { instance?: { name?: string; version?: string; autoUpdates?: boolean } }[] }>(asOwner('/api/admin/people')).people.find((entry) => entry.instance?.name === NAME);
  assert.deepEqual({ version: person?.instance?.version, autoUpdates: person?.instance?.autoUpdates }, { version: CANDIDATE_REF, autoUpdates: false }, `root's People does not show what the instance runs and how it updates: ${JSON.stringify(person?.instance)}`);
  note(`root offers ${nothing}; with automatic updates off the instance checked in and stayed on ${candidateTag}, and root's People says so`);

  step(`${nothing} picked in the instance's Settings: the instance starts its check-in at once, the release fails, it rolls itself back, tells root, and stays at its addresses`);
  const stopWatching = watchReports();
  const picked = changeUpdates({ version: nothing });
  assert.equal(picked.target, nothing);
  assert.match(picked.checking ?? '', /^instance-self-upgrade-/, `picking a release started no check-in: ${JSON.stringify(picked)}`);
  const broken = { ended: await jobEnds(picked.checking!), trail: stopWatching() };
  note(`the instance started ${picked.checking}; root heard: ${broken.trail.map((report) => `${report.status} "${report.detail}"`).join(' → ')}`);
  assert.ok(broken.ended.includes('Failed'), `the job for a missing release ended ${broken.ended}`);
  assert.ok(endsWith(broken.trail, failedUpgradeReports(candidateTag, nothing)), 'root did not hear installing then failed');
  await allOn(candidateTag);
  assert.equal(https(instanceHost, '/api/auth/sign-in').status, 200, 'the instance stopped answering at its address after the failed upgrade');
  assert.deepEqual({ status: mine().status, detail: mine().detail }, { status: 'failed', detail: `The upgrade to ${nothing} failed, so it was rolled back to ${candidateTag}` });
  cookie = handoff();
  await appAnswers();
  note(`after the failed upgrade: root shows it failed and rolled back, and sign-in through root, the handoff and the app's address still work`);
  const helmHistory = await helm('history instance');
  note(helmHistory.trim().split('\n').slice(-4).join('\n  '));
  await sh(root, `sudo sed -i 's|^INSTANCE_IMAGE_TAG=.*|INSTANCE_IMAGE_TAG=${candidateTag}|' ${REPO_DIR}/apps/backend/.env && sudo systemctl restart nowrinkles`);
  await until('root answering with the candidate release again', async () => ((await rootAnswers()) ? true : undefined));
  const following = changeUpdates({ auto: true });
  assert.deepEqual({ auto: following.auto, target: following.target, checking: following.checking }, { auto: true, target: candidateTag, checking: undefined }, 'automatic updates back on moved the instance off the release root runs');
  note(`automatic updates are back on, following root's ${candidateTag} without another check-in`);

  step(`both roll back: update.sh ${PREVIOUS_REF} on root, helm rollback on the instance`);
  const back = Date.now();
  await sh(root, `sudo bash ${UPDATE_SH} ${previous}`, true);
  note(`update.sh ${PREVIOUS_REF} took ${minutes(back)}`);
  assert.equal(await rootHead(), previous, 'root is not back on the previous release');
  assert.equal(await rootReleaseTag(), previousTag, 'root does not offer instances the previous image again');
  await until('root answering on the previous release', async () => ((await rootAnswers()) ? true : undefined));
  assert.equal((await sh(root, 'test -f /etc/systemd/system/nowrinkles-workers.service && echo split || systemctl show -p User --value nowrinkles')).trim(), '', 'root kept the split units on a release from before them');
  note('back on a release from before the split, root runs its single unit as root again');
  const revisions = (JSON.parse(await helm('history instance -o json')) as Array<{ revision: number }>).map((entry) => entry.revision);
  const history = [];
  for (const revision of revisions) history.push({ revision, values: JSON.parse(await helm(`get values instance --revision ${revision} -o json`)) as { image?: { tag?: string } } });
  const target = revisionRunning(history, previousTag);
  assert.ok(target, `no helm revision ran ${previousTag}`);
  await helm(`rollback instance ${target} --wait --timeout 720h`);
  note(`helm rolled the instance back to revision ${target}`);
  const rolledBack = await checkIn('check-in-rolled-back');
  assert.ok(rolledBack.ended.includes('Complete'), `the check-in after the rollback did not complete: ${rolledBack.ended}`);
  assert.deepEqual(rolledBack.trail[rolledBack.trail.length - 1], { status: 'ready', detail: `Running ${previousTag}` });
  await allOn(previousTag);
  cookie = handoff();
  await appAnswers();
  repositoryWorks(`rolled back to ${previousTag}`);
  await sandboxedRun('release-live-rolled-back');
  note(`root shows the instance ${mine().status}: "${mine().detail}"; everything works on ${previousTag}`);

  console.log(`\nrelease live — PASS in ${minutes(begun)} (instance ${instanceId})`);
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
    if (process.argv.includes('--keep')) {
      console.log(`\nkept: root ssh -i ${root?.privateKeyPath} -p ${root?.port} ubuntu@127.0.0.1; instance ssh -i ${instance?.privateKeyPath} -p ${instance?.port} ubuntu@127.0.0.1`);
      return;
    }
    await teardown();
  });
