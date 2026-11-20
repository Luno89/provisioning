import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createDatabase, leaseMongo, roleFromEnv } from '../apps/backend/src/platform/index.js';
import { caddyTlsSnippet } from '../apps/backend/src/infrastructure/lib/dns-providers.js';
import { instanceRouteFiles } from '../apps/backend/src/instances/lib/instance-routes.js';
import { hashCredential, publicKeyPem } from '../apps/backend/src/instances/index.js';
import { buildAppImage } from './lib/gate-runs.js';
import { devFile, devTemporalCa } from './lib/dev-temporal.js';
import { call, envArgs, minioRun, ownerOnInstance, startSplitStack, type SplitStack } from './lib/split-stack.js';
import { firstAdmin, withDatabase } from './lib/suite-root.js';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { databaseSettingsFrom } from '../apps/backend/src/platform/lib/settings.js';
import { until, waiting } from './lib/until.js';
import { containerNotRunning } from './lib/dead-states.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const STAMP = Date.now().toString(36);
const DEV_MONGO = 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin';
const ROOT_CADDY_IMAGE = 'nowrinkles/caddy:2.10.2';
const SUBNET = '100.127.250';
const DOMAIN = 'people.localhost';
const NAMES = { network: `nw-hardening-${STAMP}`, echo: `nw-hardening-echo-${STAMP}`, caddy: `nw-hardening-caddy-${STAMP}`, root: `nw-hardening-root-${STAMP}`, refused: `nw-hardening-refused-${STAMP}` };

const step = (message: string) => console.log(`\n▶ ${message}`);
const docker = (args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quietly = (args: string[]): void => { spawnSync('docker', args, { stdio: 'ignore' }); };
const anyDown = async (...names: string[]): Promise<string | undefined> => {
  for (const name of names) {
    const reason = await containerNotRunning(name);
    if (reason) return reason;
  }
  return undefined;
};
const containers: string[] = [];
const databases: string[] = [];
const run = (name: string, args: string[]): void => {
  docker(['run', '-d', '--name', name, ...args]);
  containers.push(name);
};

interface Seen { ip: string; forwardedFor: string | null; peer: string }

function askThroughRoot(port: number, host: string, forged: string): Promise<Seen> {
  return new Promise((resolveAnswer, reject) => {
    const request = https.request({ host: '127.0.0.1', port, path: '/', servername: host, headers: { host, 'x-forwarded-for': forged }, rejectUnauthorized: false }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`${host} answered ${response.statusCode}: ${body.slice(0, 200)}`));
        resolveAnswer(JSON.parse(body) as Seen);
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function clientAddresses(image: string): Promise<void> {
  step('root\'s Caddy and an instance backend run on a network of mesh-shaped addresses, each as Koala configures it');
  const work = mkdtempSync(join(tmpdir(), 'hardening-live-'));
  try {
    docker(['network', 'create', '--subnet', `${SUBNET}.0/24`, '--gateway', `${SUBNET}.1`, NAMES.network]);
    run(NAMES.echo, ['--network', NAMES.network, '--ip', `${SUBNET}.4`, '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0',
      '-v', `${join(REPO, 'tests/lib/client-address-echo.ts')}:/app/tests/lib/client-address-echo.ts:ro`, image, 'npx', 'tsx', '/app/tests/lib/client-address-echo.ts', '80', '3000', '30320']);

    const caddyDir = join(work, 'root-caddy');
    for (const folder of ['apps', 'instances', 'instance-sites', 'tls', 'admin', 'log']) mkdirSync(join(caddyDir, folder), { recursive: true });
    writeFileSync(join(caddyDir, 'tls', 'koala.caddy'), caddyTlsSnippet('internal'));
    const routed = [
      { name: 'ownbox', meshIp: `${SUBNET}.4`, nested: false },
    ];
    for (const instance of routed) writeFileSync(join(caddyDir, 'instances', `${instance.name}.caddy`), instanceRouteFiles(instance, DOMAIN).handles);
    try { docker(['image', 'inspect', ROOT_CADDY_IMAGE]); } catch { docker(['build', '-q', '-t', ROOT_CADDY_IMAGE, join(REPO, 'docker/caddy')]); }
    const tlsPort = await portToHandOn();
    run(NAMES.caddy, ['--network', NAMES.network, '--ip', `${SUBNET}.2`, '-p', `127.0.0.1:${tlsPort}:443`,
      '-e', `INGRESS_DOMAIN=${DOMAIN}`, '-e', 'APP_DOMAIN=app.koala.localhost', '-e', 'MESH_DOMAIN=mesh.koala.localhost',
      '-v', `${join(REPO, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-v', `${join(caddyDir, 'tls')}:/etc/caddy/tls:ro`,
      '-v', `${join(caddyDir, 'apps')}:/etc/caddy/apps:ro`, '-v', `${join(caddyDir, 'instances')}:/etc/caddy/instances:ro`, '-v', `${join(caddyDir, 'instance-sites')}:/etc/caddy/instance-sites:ro`,
      '-v', `${join(caddyDir, 'admin')}:/run/caddy-admin`, '-v', `${join(caddyDir, 'log')}:/var/log/caddy`, ROOT_CADDY_IMAGE]);

    const own = await until('an own-machine instance answering through root\'s Caddy', () => askThroughRoot(tlsPort, `ownbox.${DOMAIN}`, '6.6.6.6'), () => anyDown(NAMES.caddy, NAMES.echo));
    const visitor = own.ip;
    assert.notEqual(visitor, '6.6.6.6', 'root\'s Caddy passed on an address the visitor made up');
    assert.notEqual(visitor, `${SUBNET}.2`, 'an own-machine instance saw root\'s Caddy instead of the visitor');
    console.log(`  an instance on its owner's machine sees the visitor (${visitor}), not root's Caddy (${SUBNET}.2) nor the made-up 6.6.6.6`);
  } finally {
    for (const name of [NAMES.caddy, NAMES.echo]) quietly(['rm', '-f', name]);
    quietly(['network', 'rm', NAMES.network]);
    rmSync(work, { recursive: true, force: true });
  }
}

async function refusesToStart(image: string, what: string, env: Record<string, string>, extra: string[], command: string, expected: RegExp): Promise<void> {
  const name = `${NAMES.refused}-${command}-${randomBytes(3).toString('hex')}`;
  run(name, ['--network', 'host', '--env-file', devFile('apps/backend/.env'), ...extra, ...envArgs(env), image, command]);
  const said = (): string => execFileSync('sh', ['-c', `docker logs ${name} 2>&1`], { encoding: 'utf8' });
  await until(`${what} stopping`, async () => { const running = docker(['inspect', '-f', '{{.State.Running}}', name]); return running === 'false' ? true : waiting(`the container's Running is ${running}`); });
  const exit = docker(['inspect', '-f', '{{.State.ExitCode}}', name]);
  const text = said();
  assert.notEqual(exit, '0', `${what} ended well: ${text.slice(-400)}`);
  assert.match(text, expected, `${what} did not say why: ${text.slice(-800)}`);
  console.log(`  ${what} stopped (exit ${exit}): ${(expected.exec(text)?.[0] ?? '').slice(0, 160)}`);
  quietly(['rm', '-f', name]);
}

async function plaintextRefusals(image: string): Promise<void> {
  step('production refuses to talk to Temporal in plaintext: the backend and a worker stop without the CA');
  const port = String(await portToHandOn());
  await refusesToStart(image, 'the backend without Temporal\'s CA', { TEMPORAL_TLS_CA: '/nowhere/ca.crt', PORT: port }, [], 'backend', /Temporal's certificate authority is not at \/nowhere\/ca\.crt \(TEMPORAL_TLS_CA\)\. Koala never talks to Temporal in plaintext/);
  await refusesToStart(image, 'the host worker without Temporal\'s CA', { TEMPORAL_TLS_CA: '/nowhere/ca.crt', HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: String(await portToHandOn()) }, [], 'worker-host', /Koala never talks to Temporal in plaintext/);

  step('an instance in production refuses to sign in through root over plain http to the open internet');
  dotenv.config({ path: devFile('apps/backend/.env'), quiet: true });
  const signing = roleFromEnv({ ...process.env, ROLE: 'root' }).signing!;
  const database = `koala_hardening_${STAMP}_plain`;
  databases.push(database);
  await refusesToStart(image, 'an instance whose ROOT_URL is http://app.nowrinkles.dev', {
    ...minioRun(await portToHandOn()).env,
    ROLE: 'instance', INSTANCE_ID: 'inst-hardening', INSTANCE_OWNER_ID: 'nobody', ROOT_URL: 'http://app.nowrinkles.dev',
    ROOT_PUBLIC_KEYS: Buffer.from(publicKeyPem(signing.publicKey)).toString('base64'), MONGO_URI: withDatabase(process.env.MONGO_URI || DEV_MONGO, database), PORT: String(await portToHandOn()),
  }, devTemporalCa(), 'backend', /ROOT_URL is http:\/\/app\.nowrinkles\.dev: plain http to an address on the open internet/);
}

async function noStubClouds(stack: SplitStack): Promise<void> {
  step('an instance in production makes no cluster of its own and offers no cloud to make one on');
  const session = await ownerOnInstance(stack);
  const offered = await call(`${stack.instanceUrl}/api/cluster-providers`, { cookie: session });
  assert.equal(offered.status, 404, `the instance still answers for cluster providers: ${JSON.stringify(offered.body)}`);
  const providers = (await call(`${stack.instanceUrl}/api/credentials`, { cookie: session })).body as { providers: { provider: string; clusters?: string }[] };
  for (const name of ['aws', 'gcp', 'azure', 'do', 'hetzner']) {
    assert.ok(!providers.providers.some((entry) => entry.provider === name), `Cloud providers still lists ${name}`);
  }
  assert.ok(!providers.providers.some((entry) => 'clusters' in entry), 'Cloud providers still says which providers make clusters');
  for (const provider of ['aws', 'gcp', 'azure', 'k3d', 'hetzner', 'do']) {
    const asked = await call(`${stack.instanceUrl}/api/clusters`, { method: 'POST', cookie: session, body: JSON.stringify({ name: `hardening-${provider}-${STAMP}`, provider }) });
    assert.equal(asked.status, 404, `asking for a ${provider} cluster: ${JSON.stringify(asked.body)}`);
  }
  const clusters = (await call(`${stack.instanceUrl}/api/clusters`, { cookie: session })).body as { name: string }[];
  assert.ok(!clusters.some((cluster) => cluster.name.includes(STAMP)), 'a cluster was recorded anyway');
  console.log('  no cluster providers, no cloud credentials for clusters, and asking for a cluster of any provider finds no route; nothing recorded');
}

async function rootNeverCallsMadeUpAddresses(stack: SplitStack, image: string): Promise<void> {
  step('a root that is not a lab starts in production on a database of its own');
  const port = await portToHandOn();
  const rootUrl = `http://localhost:${port}`;
  const database = `koala_hardening_${STAMP}_root`;
  databases.push(database);
  const mongoUri = withDatabase(process.env.MONGO_URI || DEV_MONGO, database);
  const setupCode = randomBytes(12).toString('base64url');
  run(NAMES.root, ['--network', 'host', '--env-file', devFile('apps/backend/.env'), ...devTemporalCa(), ...envArgs({
    ROLE: 'root', PORT: String(port), PUBLIC_URL: rootUrl, TRUST_PROXY: '1', MONGO_URI: mongoUri, ADMIN_SETUP_CODE: setupCode, TEMPORAL_NAMESPACE: stack.names.namespace,
    MACHINE_GATEWAY_PORT: String(await portToHandOn()), MAIL_SMTP_URL: `smtp://127.0.0.1:${stack.ports.smtp}`, MAIL_FROM: 'koala@hardening.test',
  }), image, 'backend']);
  await until('the root answering', async () => { const answer = await fetch(`${rootUrl}/api/identity/keys`).catch((err: unknown) => err instanceof Error ? err.message : String(err)); return typeof answer !== 'string' && answer.ok ? true : waiting(typeof answer === 'string' ? `root did not answer: ${answer.slice(0, 200)}` : `root answered ${answer.status}`); }, () => containerNotRunning(NAMES.root));
  const owner = await firstAdmin(rootUrl, { suite: 'hardening', database, mongoUri, setupCode, namespace: stack.names.namespace, metricsPort: 0, env: [] });

  let heard = 0;
  const listener = http.createServer((_req, res) => { heard += 1; res.end('{}'); });
  await new Promise<void>((resolveListen) => listener.listen(0, '127.0.0.1', resolveListen));
  const madeUp = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  try {
    const credential = randomBytes(24).toString('base64url');
    const db = createDatabase(databaseSettingsFrom({ ...process.env, MONGO_URI: mongoUri }));
    await db.init();
    try {
      await db.instances.saveInstance({ id: 'inst-hardening', ownerId: owner.id, name: 'hardbox', url: `https://hardbox.${DOMAIN}`, credentialHash: hashCredential(credential), status: 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

      step('root refuses an address an instance reports on this machine, a private network or the cloud\'s metadata service');
      for (const url of [madeUp, 'http://10.0.0.5:3001', 'http://169.254.169.254']) {
        const reported = await call(`${rootUrl}/api/instances/status`, { method: 'POST', headers: { 'X-Instance-Id': 'inst-hardening', Authorization: `Bearer ${credential}` }, body: JSON.stringify({ status: 'ready', url }) });
        assert.equal(reported.status, 400, `${url}: ${JSON.stringify(reported.body)}`);
        assert.match((reported.body as { error: string }).error, new RegExp(`^root does not call ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
      }
      assert.equal((await db.instances.getInstances(owner.id))[0]?.url, `https://hardbox.${DOMAIN}`, 'root kept a refused address');
      console.log(`  each refused with its reason; root kept https://hardbox.${DOMAIN}`);

      step('an address stored before is never called: not to ask how the instance signs in, not to tell it someone signed out');
      await db.instances.saveInstance({ ...(await db.instances.getInstances(owner.id))[0]!, url: madeUp });
      await db.instances.saveSignInKey('inst-hardening', { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'x', kid: 'k' }, since: new Date().toISOString() });
      const go = await call(`${rootUrl}/api/identity/go`, { cookie: owner.cookie });
      assert.equal(go.location, `${madeUp}/api/auth/oidc/start`, `root sent the owner to ${go.location}`);
      const ended = await call(`${rootUrl}/api/auth/sessions/end-others`, { method: 'POST', cookie: owner.cookie, body: '{}' });
      assert.equal(ended.status, 200, JSON.stringify(ended.body));
      const delivery = await until('root trying to tell the instance', async () => {
        const [pending] = await db.instances.pendingLogouts();
        return pending?.lastError ? pending : waiting(pending ? 'a logout is pending with no error yet' : 'no logout is pending'); 
      }, () => containerNotRunning(NAMES.root));
      assert.match(delivery.lastError!, /Koala does not reach that from here: 127\.0\.0\.1 is a private, loopback, mesh or reserved address/);
      assert.equal(heard, 0, 'root called the made-up address');
      console.log(`  root sent the owner to OpenID sign-in without asking, and its logout stayed undelivered: ${delivery.lastError}`);
    } finally {
      await db.close?.();
    }
  } finally {
    await new Promise((resolveClose) => listener.close(resolveClose));
    quietly(['rm', '-f', NAMES.root]);
  }
}

async function dropDatabases(): Promise<void> {
  const { client, release } = await leaseMongo(process.env.MONGO_URI || DEV_MONGO);
  try {
    for (const database of databases) if (database.startsWith('koala_hardening_')) await client.db(database).dropDatabase();
  } finally {
    await release();
  }
}

async function main(): Promise<void> {
  dotenv.config({ path: devFile('apps/backend/.env'), quiet: true });
  const image = await buildAppImage(REPO, execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), (line) => console.log(`  ${line}`));
  try {
    await clientAddresses(image);
    await plaintextRefusals(image);
    step('a root, an instance and a hub of their own start in production containers from this commit\'s image');
    const stack = await startSplitStack();
    try {
      await noStubClouds(stack);
      await rootNeverCallsMadeUpAddresses(stack, image);
    } catch (err) {
      for (const side of ['root', 'instance'] as const) console.error(`\n── ${side}'s last lines ──\n${await stack.logs(side, 40)}`);
      throw err;
    } finally {
      await stack.stop();
    }
  } finally {
    for (const name of containers) quietly(['rm', '-f', name]);
    await dropDatabases().catch((err: Error) => console.error(`  could not drop ${databases.join(', ')}: ${err.message}`));
  }
  console.log('\nhardening live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
