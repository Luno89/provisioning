import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDisposableVm, findFreePort, type DisposableVm } from './lib/disposable-vm.js';
import { labDnsmasq, labHostsLine } from './lib/release-lab.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
const DOMAIN = 'koala.internal';
const ROOT_LAN = '10.77.0.1';
const ROOT_PORT = 3001;
const ROOT_URL = `http://app.${DOMAIN}:${ROOT_PORT}`;
const REPO_DIR = '/opt/nowrinkles';
const ORIGIN = '/opt/nowrinkles-origin.git';
const MINIO_IMAGE = 'pgsty/minio:RELEASE.2026-03-14T12-00-00Z';
const TAILSCALE_IMAGE = 'tailscale/tailscale:v1.88.2';
const MINIO = 'nw-restore-minio';
const PROBE = 'restore-probe';
const STAMP = Date.now().toString(36);
const EMAIL = `restore-live-${STAMP}@example.com`;
const PASSWORD = randomBytes(18).toString('base64url');
const INSTANCE_ID = `inst-restore-${STAMP}`;
const BACKUP = {
  user: `restore${STAMP}`,
  secret: randomBytes(18).toString('base64url'),
  password: randomBytes(24).toString('base64url'),
};

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const step = (message: string) => console.log(`\n▶ ${message}`);
const note = (message: string) => console.log(`  ${message}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const minutes = (since: number) => `${((Date.now() - since) / 60_000).toFixed(1)} min`;

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  let last = '';
  for (let tries = 0; ; tries += 1) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      last = (err as Error).message;
    }
    if (tries > 0 && tries % 24 === 0) note(`still waiting for ${what}${last ? ` (${last.slice(0, 200)})` : ''}`);
    await sleep(5000);
  }
}

const sshArgs = (vm: DisposableVm) => ['-i', vm.privateKeyPath, '-p', String(vm.port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ServerAliveInterval=30', `${vm.username}@${vm.host}`];

function inVm(vm: DisposableVm, command: string, stream = false): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn('ssh', [...sshArgs(vm), command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; if (stream) process.stdout.write(`    ${String(chunk).replace(/\n(?!$)/g, '\n    ')}`); });
    child.stderr.on('data', (chunk) => { out += chunk; if (stream) process.stderr.write(`    ${chunk}`); });
    child.on('close', (code) => done({ code: code ?? 1, out }));
  });
}

async function sh(vm: DisposableVm, command: string, stream = false): Promise<string> {
  const { code, out } = await inVm(vm, command, stream);
  if (code !== 0) throw new Error(`exited ${code} running: ${command}\n${out.slice(-3000)}`);
  return out;
}

interface Answer { status: number; body: string; cookie: string }

function https(tlsPort: number, ca: string, path: string, init: { method?: string; body?: unknown; cookie?: string } = {}): Answer {
  const host = `app.${DOMAIN}`;
  const args = ['-sS', '-D', '-', '--resolve', `${host}:${tlsPort}:127.0.0.1`, '--cacert', ca, '-X', init.method ?? 'GET'];
  if (init.body !== undefined) args.push('-H', 'content-type: application/json', '--data', JSON.stringify(init.body));
  if (init.cookie) args.push('-H', `cookie: ${init.cookie}`);
  const out = execFileSync('curl', [...args, `https://${host}:${tlsPort}${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const blocks = out.split(/\r?\n\r?\n/);
  const head = blocks.shift() ?? '';
  const [statusLine, ...lines] = head.split(/\r?\n/);
  const cookie = lines.find((line) => /^set-cookie:\s*(__Host-)?session=/i.test(line))?.replace(/^set-cookie:\s*/i, '').split(';')[0] ?? '';
  return { status: Number((statusLine ?? '').split(' ')[1]), body: blocks.join('\n\n'), cookie };
}

interface Root { vm: DisposableVm; tlsPort: number }

let work = '';
const roots: Root[] = [];

async function standUpRoot(label: string, commit: string): Promise<Root> {
  const tlsPort = await findFreePort();
  const vm = await createDisposableVm(label, { memoryMB: 12288, cpus: 4, diskGB: 60, forwards: [{ host: tlsPort, guest: 443 }], lan: { listen: await findFreePort(), address: `${ROOT_LAN}/24` } });
  const root = { vm, tlsPort };
  roots.push(root);
  await sh(vm, [
    `echo '${labHostsLine(DOMAIN, ROOT_LAN)}' | sudo tee -a /etc/hosts >/dev/null`,
    'sudo mkdir -p /etc/dnsmasq.d',
    `printf '%s' '${labDnsmasq(DOMAIN, ROOT_LAN)}' | sudo tee /etc/dnsmasq.d/koala-lab.conf >/dev/null`,
    'sudo apt-get update -qq >/dev/null',
    'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq dnsmasq git >/dev/null',
    'sudo systemctl restart dnsmasq',
    `sudo git init -q --bare ${ORIGIN} && sudo chown -R ubuntu ${ORIGIN} && sudo git config --system --add safe.directory ${ORIGIN}`,
  ].join(' && '));
  execFileSync('git', ['-C', REPO, 'push', '-q', '--force', `ssh://ubuntu@127.0.0.1:${vm.port}${ORIGIN}`, `${commit}:refs/heads/candidate`],
    { env: { ...process.env, GIT_SSH_COMMAND: `ssh -i ${vm.privateKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR` } });
  await sh(vm, `sudo git clone -q ${ORIGIN} ${REPO_DIR} && sudo git -C ${REPO_DIR} checkout -q --detach ${commit}`);
  const begun = Date.now();
  await sh(vm, `sudo env ROOT_TLS=internal DOMAIN=${DOMAIN} PUBLIC_URL=${ROOT_URL} bash ${REPO_DIR}/scripts/root-node/bootstrap.sh > /tmp/bootstrap.log 2>&1 || { tail -60 /tmp/bootstrap.log; exit 1; }`);
  await sh(vm, 'sudo systemctl start nowrinkles.service nowrinkles-workers.service');
  const ca = join(work, `${label}-ca.crt`);
  writeFileSync(ca, await sh(vm, 'sudo cat /usr/local/share/ca-certificates/koala-lab.crt'));
  await until(`${label} answering through its Caddy`, async () => (https(tlsPort, ca, '/api/identity/keys').status === 200 ? true : undefined));
  note(`${label}: bootstrapped and answering in ${minutes(begun)}`);
  return root;
}

const headscale = (root: Root, args: string) => sh(root.vm, `sudo docker exec provisioning-headscale headscale ${args}`);
const nodeNames = async (root: Root) => (JSON.parse(await headscale(root, 'nodes list -o json')) as { given_name?: string; name?: string }[]).map((node) => node.given_name ?? node.name ?? '');
const temporal = async (root: Root, args: string) => {
  const name = (await sh(root.vm, "sudo docker ps --filter label=com.docker.compose.service=temporal --format '{{.Names}}'")).trim();
  return sh(root.vm, `sudo docker exec ${name} temporal ${args} --address 127.0.0.1:7236`);
};
const WORKFLOW = `restore-live-${STAMP}`;

async function teardown(): Promise<void> {
  for (const root of roots) await root.vm.destroy().catch(() => undefined);
  try { run('docker', ['rm', '-f', MINIO]); } catch { /* gone */ }
  if (work) rmSync(work, { recursive: true, force: true });
}

async function main(): Promise<void> {
  work = mkdtempSync(join(tmpdir(), 'restore-live-'));
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  const minioPort = await findFreePort();
  const repository = `s3:http://10.0.2.2:${minioPort}/koala-backup`;
  const backupEnv = `BACKUP_REPOSITORY=${repository} BACKUP_PASSWORD=${BACKUP.password} AWS_ACCESS_KEY_ID=${BACKUP.user} AWS_SECRET_ACCESS_KEY=${BACKUP.secret}`;

  step('an S3 store on this computer stands in for the provider\'s object storage');
  run('docker', ['run', '-d', '--name', MINIO, '-p', `127.0.0.1:${minioPort}:9000`, '-e', `MINIO_ROOT_USER=${BACKUP.user}`, '-e', `MINIO_ROOT_PASSWORD=${BACKUP.secret}`, MINIO_IMAGE, 'server', '/data']);
  note(`MinIO at 127.0.0.1:${minioPort}, which the VMs reach at 10.0.2.2`);

  step('two fresh roots, each bootstrapped by the real bootstrap.sh in lab mode, side by side');
  const [first, second] = await Promise.all([standUpRoot('restore-first', commit), standUpRoot('restore-second', commit)]);
  const firstCa = join(work, 'restore-first-ca.crt');

  step('the first root holds an account, an instance, a node on its mesh and Temporal\'s history');
  const setupCode = (await sh(first.vm, `sudo grep '^ADMIN_SETUP_CODE=' ${REPO_DIR}/apps/backend/.env | cut -d= -f2-`)).trim();
  assert.equal(https(first.tlsPort, firstCa, '/api/auth/register', { method: 'POST', body: { email: EMAIL, password: PASSWORD, inviteCode: setupCode } }).status, 200);
  const signedIn = https(first.tlsPort, firstCa, '/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  assert.equal(signedIn.status, 200, signedIn.body);
  const owner = (JSON.parse(https(first.tlsPort, firstCa, '/api/auth/me', { cookie: signedIn.cookie }).body) as { user?: { id: string }; id?: string });
  const ownerId = owner.user?.id ?? owner.id;
  assert.ok(ownerId, 'the account has no id');
  await sh(first.vm, `cd ${REPO_DIR} && sudo npm run -s instances -w apps/backend -- add ${INSTANCE_ID} ${ownerId} http://${INSTANCE_ID}.${DOMAIN}`);
  await headscale(first, `users create platform-${ownerId}`);
  const userId = (JSON.parse(await headscale(first, 'users list -o json')) as { id: string | number; name: string }[]).find((user) => user.name === `platform-${ownerId}`)?.id;
  assert.ok(userId !== undefined, 'Headscale did not make the owner\'s user');
  const key = (JSON.parse(await headscale(first, `preauthkeys create --user ${userId} --expiration 10m -o json`)) as { key: string }).key;
  await sh(first.vm, [
    `sudo docker run -d --name ${PROBE} --network host -v /usr/local/share/ca-certificates/koala-lab.crt:/lab-ca.crt:ro -e SSL_CERT_FILE=/lab-ca.crt`,
    `-e TS_AUTHKEY=${key} -e TS_HOSTNAME=${PROBE} -e TS_USERSPACE=true -e TS_STATE_DIR=/var/lib/tailscale`,
    `-e "TS_EXTRA_ARGS=--login-server=https://mesh.${DOMAIN}" -e TS_SOCKET=/tmp/probe.sock -e TS_TAILSCALED_EXTRA_ARGS=--port=0 ${TAILSCALE_IMAGE} >/dev/null`,
  ].join(' '));
  await until('the probe node on the first root\'s mesh', async () => ((await nodeNames(first)).includes(PROBE) ? true : undefined));
  const firstMeshIp = (await sh(first.vm, 'tailscale ip -4')).trim().split('\n')[0]!;
  await temporal(first, `workflow start --type RestoreLiveProbe --task-queue restore-live --workflow-id ${WORKFLOW} --search-attribute 'KoalaOwner="platform"'`);
  note(`${EMAIL} is its admin, ${INSTANCE_ID} is their instance, ${PROBE} is on its mesh beside root at ${firstMeshIp}, and Temporal holds workflow ${WORKFLOW}`);

  step('the first root backs up: units.sh turns the nightly timer on once a repository is set, and backup.sh sends one encrypted snapshot');
  await sh(first.vm, `sudo bash -c 'for pair in ${backupEnv}; do echo "$pair" >> ${REPO_DIR}/apps/backend/.env; done'`);
  await sh(first.vm, `sudo REPO_DIR=${REPO_DIR} bash ${REPO_DIR}/scripts/root-node/units.sh`);
  assert.equal((await sh(first.vm, 'systemctl is-enabled koala-backup.timer koala-backup-check.timer')).trim(), 'enabled\nenabled');
  const backedUp = await sh(first.vm, `sudo REPO_DIR=${REPO_DIR} bash ${REPO_DIR}/scripts/root-node/backup.sh`, true);
  assert.match(backedUp, /backed up to .* snapshot [0-9a-f]{8}/);
  await sh(first.vm, `sudo REPO_DIR=${REPO_DIR} bash ${REPO_DIR}/scripts/root-node/backup.sh check`, true);
  const stored = run('docker', ['exec', MINIO, 'sh', '-c', 'find /data/koala-backup -type f | wc -l']).trim();
  assert.ok(Number(stored) > 0, 'nothing reached the object store');
  note(`${stored} files in the bucket; the snapshot is checked whole`);

  step('the second root, bootstrapped fresh, restores that snapshot with restore.sh');
  const restored = Date.now();
  await sh(second.vm, `sudo env ${backupEnv} REPO_DIR=${REPO_DIR} bash ${REPO_DIR}/scripts/root-node/restore.sh latest`, true);
  note(`restore.sh took ${minutes(restored)}`);
  const secondCa = join(work, 'restore-second-restored-ca.crt');
  writeFileSync(secondCa, await sh(second.vm, 'sudo cat /usr/local/share/ca-certificates/koala-lab.crt'));
  await until('the restored root answering through its Caddy', async () => (https(second.tlsPort, secondCa, '/api/identity/keys').status === 200 ? true : undefined));

  step('the restored root is the first one: the same certificate authority, account, instance, mesh and history');
  assert.equal(https(second.tlsPort, firstCa, '/api/identity/keys').status, 200, 'the restored root does not serve the first root\'s certificates');
  const again = https(second.tlsPort, firstCa, '/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  assert.equal(again.status, 200, `the owner could not sign in on the restored root: ${again.body}`);
  const old = https(second.tlsPort, firstCa, '/api/auth/me', { cookie: signedIn.cookie });
  assert.equal(old.status, 200, 'a session the first root signed is refused by the restored one, so its session key was not restored');
  const mine = JSON.parse(https(second.tlsPort, firstCa, '/api/instances/mine', { cookie: again.cookie }).body) as { instance?: { id: string } };
  assert.equal(mine.instance?.id, INSTANCE_ID, `the restored root does not know the owner's instance: ${JSON.stringify(mine)}`);
  assert.ok((await nodeNames(second)).includes(PROBE), 'the restored Headscale does not know the probe node');
  const secondMeshIp = (await sh(second.vm, 'tailscale ip -4')).trim().split('\n')[0]!;
  assert.equal(secondMeshIp, firstMeshIp, 'the restored root is not the old root on its mesh');
  const described = JSON.parse(await temporal(second, `workflow describe --workflow-id ${WORKFLOW} -o json`)) as { workflowExecutionInfo?: { type?: { name?: string } } };
  assert.equal(described.workflowExecutionInfo?.type?.name, 'RestoreLiveProbe', 'the restored Temporal does not hold the workflow started before the backup');
  assert.equal((await sh(second.vm, 'systemctl is-active nowrinkles.service')).trim(), 'active');
  note(`signed in with the old password and the old session, ${INSTANCE_ID} listed, ${PROBE} on the mesh, root at ${secondMeshIp} again, ${WORKFLOW} in Temporal`);

  console.log('\nrestore live — PASS');
}

main().then(async () => { await teardown(); process.exit(0); }, async (err) => {
  console.error(err);
  await teardown();
  process.exit(1);
});
