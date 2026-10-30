import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { createDatabase, roleFromEnv } from '../apps/backend/src/platform/index.js';
import { caddyTlsSnippet } from '../apps/backend/src/infrastructure/lib/dns-providers.js';
import { instanceRouteFiles } from '../apps/backend/src/instances/lib/instance-routes.js';
import { PROXY_IMAGE, proxyCaddyfile } from '../apps/backend/src/instances/lib/pool.js';
import { hashCredential, publicKeyPem } from '../apps/backend/src/instances/index.js';
import { buildAppImage } from './lib/gate-runs.js';
import { devFile, devTemporalCa } from './lib/dev-temporal.js';
import { call, envArgs, ownerOnInstance, startSplitStack, type SplitStack } from './lib/split-stack.js';
import { firstAdmin, withDatabase } from './lib/suite-root.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const STAMP = Date.now().toString(36);
const DEV_MONGO = 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin';
const ROOT_CADDY_IMAGE = 'nowrinkles/caddy:2.10.2';
const SUBNET = '100.127.250';
const DOMAIN = 'people.localhost';
const NAMES = { network: `nw-hardening-${STAMP}`, echo: `nw-hardening-echo-${STAMP}`, pool: `nw-hardening-pool-${STAMP}`, oldPool: `nw-hardening-oldpool-${STAMP}`, caddy: `nw-hardening-caddy-${STAMP}`, root: `nw-hardening-root-${STAMP}`, refused: `nw-hardening-refused-${STAMP}` };
const POOL_PORTS = { backend: 35000, edge: 35001, registry: 35002 };

const step = (message: string) => console.log(`\n▶ ${message}`);
const docker = (args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quietly = (args: string[]): void => { try { docker(args); } catch { /* gone */ } };
const containers: string[] = [];
const databases: string[] = [];
const run = (name: string, args: string[]): void => {
  docker(['run', '-d', '--name', name, ...args]);
  containers.push(name);
};

async function until<T>(what: string, probe: () => Promise<T | undefined>, logs?: () => string): Promise<T> {
  let last = '';
  for (let tries = 1; ; tries += 1) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      last = (err as Error).message;
    }
    if (tries % 60 === 0) console.log(`    still waiting for ${what}${last ? ` (${last.slice(0, 160)})` : ''}`);
    if (tries === 600) throw new Error(`${what} never happened${last ? `: ${last}` : ''}${logs ? `\n${logs()}` : ''}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolvePort(address.port));
    });
  });
}

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

async function askDirectly(url: string, forged: string): Promise<Seen> {
  const response = await fetch(url, { headers: { 'x-forwarded-for': forged } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return await response.json() as Seen;
}

async function clientAddresses(image: string): Promise<void> {
  step('root\'s Caddy, the pool\'s proxy and an instance backend run on a network of mesh-shaped addresses, each as Koala configures it');
  const work = mkdtempSync(join(tmpdir(), 'hardening-live-'));
  try {
    docker(['network', 'create', '--subnet', `${SUBNET}.0/24`, '--gateway', `${SUBNET}.1`, NAMES.network]);
    const pool = proxyCaddyfile([{ name: 'hardpool', ports: POOL_PORTS }], `${SUBNET}.3`, [`${SUBNET}.2`]);
    const oldPool = proxyCaddyfile([{ name: 'oldpool', ports: POOL_PORTS }], `${SUBNET}.5`, []).replace(/\n\t\theader_up X-Forwarded-For \{client_ip\}/g, '');
    const upstreams = [...new Set([...pool.matchAll(/reverse_proxy (\S+):\d+/g), ...oldPool.matchAll(/reverse_proxy (\S+):\d+/g)].map((match) => match[1]!))];
    run(NAMES.echo, ['--network', NAMES.network, '--ip', `${SUBNET}.4`, ...upstreams.flatMap((alias) => ['--network-alias', alias]), '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0',
      image, 'npx', 'tsx', '/app/tests/lib/client-address-echo.ts', '80', '3000', '30320']);

    for (const [name, at, config] of [[NAMES.pool, '3', pool], [NAMES.oldPool, '5', oldPool]] as const) {
      const dir = join(work, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'Caddyfile'), config);
      run(name, ['--network', NAMES.network, '--ip', `${SUBNET}.${at}`, '-v', `${dir}:/etc/caddy:ro`, PROXY_IMAGE, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
    }

    const caddyDir = join(work, 'root-caddy');
    for (const folder of ['apps', 'instances', 'instance-sites', 'tls', 'admin', 'log']) mkdirSync(join(caddyDir, folder), { recursive: true });
    writeFileSync(join(caddyDir, 'tls', 'koala.caddy'), caddyTlsSnippet('internal'));
    const routed = [
      { name: 'hardpool', meshIp: `${SUBNET}.3`, nested: false, ports: { backend: POOL_PORTS.backend, edge: POOL_PORTS.edge } },
      { name: 'oldpool', meshIp: `${SUBNET}.5`, nested: false, ports: { backend: POOL_PORTS.backend, edge: POOL_PORTS.edge } },
      { name: 'ownbox', meshIp: `${SUBNET}.4`, nested: false },
    ];
    for (const instance of routed) writeFileSync(join(caddyDir, 'instances', `${instance.name}.caddy`), instanceRouteFiles(instance, DOMAIN).handles);
    try { docker(['image', 'inspect', ROOT_CADDY_IMAGE]); } catch { docker(['build', '-q', '-t', ROOT_CADDY_IMAGE, join(REPO, 'docker/caddy')]); }
    const tlsPort = await freePort();
    run(NAMES.caddy, ['--network', NAMES.network, '--ip', `${SUBNET}.2`, '-p', `127.0.0.1:${tlsPort}:443`,
      '-e', `INGRESS_DOMAIN=${DOMAIN}`, '-e', 'APP_DOMAIN=app.koala.localhost', '-e', 'MESH_DOMAIN=mesh.koala.localhost',
      '-v', `${join(REPO, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-v', `${join(caddyDir, 'tls')}:/etc/caddy/tls:ro`,
      '-v', `${join(caddyDir, 'apps')}:/etc/caddy/apps:ro`, '-v', `${join(caddyDir, 'instances')}:/etc/caddy/instances:ro`, '-v', `${join(caddyDir, 'instance-sites')}:/etc/caddy/instance-sites:ro`,
      '-v', `${join(caddyDir, 'admin')}:/run/caddy-admin`, '-v', `${join(caddyDir, 'log')}:/var/log/caddy`, ROOT_CADDY_IMAGE]);

    const logs = () => [NAMES.caddy, NAMES.pool, NAMES.echo].map((name) => `── ${name} ──\n${(() => { try { return execFileSync('docker', ['logs', '--tail', '20', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { return String((err as { stderr?: string }).stderr ?? ''); } })()}`).join('\n');
    const own = await until('an own-machine instance answering through root\'s Caddy', () => askThroughRoot(tlsPort, `ownbox.${DOMAIN}`, '6.6.6.6'), logs);
    const visitor = own.ip;
    assert.notEqual(visitor, '6.6.6.6', 'root\'s Caddy passed on an address the visitor made up');
    assert.notEqual(visitor, `${SUBNET}.2`, 'an own-machine instance saw root\'s Caddy instead of the visitor');
    console.log(`  an instance on its owner's machine sees the visitor (${visitor}), not root's Caddy (${SUBNET}.2) nor the made-up 6.6.6.6`);

    step('a pool instance, two hops behind root\'s Caddy, sees the same visitor');
    const pooled = await until('a pool instance answering through root\'s Caddy and the pool\'s proxy', () => askThroughRoot(tlsPort, `hardpool.${DOMAIN}`, '6.6.6.6'), logs);
    assert.equal(pooled.ip, visitor, `a pool instance saw ${pooled.ip} (forwarded for ${pooled.forwardedFor}) instead of the visitor ${visitor}`);
    const before = await until('the proxy as it was before answering', () => askThroughRoot(tlsPort, `oldpool.${DOMAIN}`, '6.6.6.6'), logs);
    assert.equal(before.ip, `${SUBNET}.2`, `the proxy as it was before showed ${before.ip}`);
    console.log(`  it sees ${pooled.ip}; the proxy as it was before made every visitor ${before.ip}, root's own address`);

    step('anyone reaching the pool\'s proxy around root\'s Caddy is taken for who they are, whatever they claim');
    const around = await askDirectly(`http://${SUBNET}.3:${POOL_PORTS.backend}/`, '6.6.6.6');
    assert.equal(around.ip, `${SUBNET}.1`, `a caller around root's Caddy was taken for ${around.ip}`);
    console.log(`  a caller at ${SUBNET}.1 claiming 6.6.6.6 is taken for ${around.ip}`);
  } finally {
    for (const name of [NAMES.caddy, NAMES.pool, NAMES.oldPool, NAMES.echo]) quietly(['rm', '-f', name]);
    quietly(['network', 'rm', NAMES.network]);
    rmSync(work, { recursive: true, force: true });
  }
}

async function refusesToStart(image: string, what: string, env: Record<string, string>, extra: string[], command: string, expected: RegExp): Promise<void> {
  const name = `${NAMES.refused}-${command}-${randomBytes(3).toString('hex')}`;
  run(name, ['--network', 'host', '--env-file', devFile('apps/backend/.env'), ...extra, ...envArgs(env), image, command]);
  const said = (): string => execFileSync('sh', ['-c', `docker logs ${name} 2>&1`], { encoding: 'utf8' });
  await until(`${what} stopping`, async () => (docker(['inspect', '-f', '{{.State.Running}}', name]) === 'false' ? true : undefined), said);
  const exit = docker(['inspect', '-f', '{{.State.ExitCode}}', name]);
  const text = said();
  assert.notEqual(exit, '0', `${what} ended well: ${text.slice(-400)}`);
  assert.match(text, expected, `${what} did not say why: ${text.slice(-800)}`);
  console.log(`  ${what} stopped (exit ${exit}): ${(expected.exec(text)?.[0] ?? '').slice(0, 160)}`);
  quietly(['rm', '-f', name]);
}

async function plaintextRefusals(image: string): Promise<void> {
  step('production refuses to talk to Temporal in plaintext: the backend and a worker stop without the CA');
  const port = String(await freePort());
  await refusesToStart(image, 'the backend without Temporal\'s CA', { TEMPORAL_TLS_CA: '/nowhere/ca.crt', PORT: port }, [], 'backend', /Temporal's certificate authority is not at \/nowhere\/ca\.crt \(TEMPORAL_TLS_CA\)\. In production Koala never talks to Temporal in plaintext/);
  await refusesToStart(image, 'the host worker without Temporal\'s CA', { TEMPORAL_TLS_CA: '/nowhere/ca.crt', HEALTH_PORT: '0' }, [], 'worker-host', /In production Koala never talks to Temporal in plaintext/);

  step('an instance in production refuses to sign in through root over plain http to the open internet');
  dotenv.config({ path: devFile('apps/backend/.env'), quiet: true });
  const signing = roleFromEnv({ ...process.env, ROLE: 'root' }).signing!;
  const database = `koala_hardening_${STAMP}_plain`;
  databases.push(database);
  await refusesToStart(image, 'an instance whose ROOT_URL is http://app.nowrinkles.dev', {
    ROLE: 'instance', INSTANCE_ID: 'inst-hardening', INSTANCE_OWNER_ID: 'nobody', ROOT_URL: 'http://app.nowrinkles.dev',
    ROOT_PUBLIC_KEYS: Buffer.from(publicKeyPem(signing.publicKey)).toString('base64'), MONGO_URI: withDatabase(process.env.MONGO_URI || DEV_MONGO, database), PORT: String(await freePort()),
  }, devTemporalCa(), 'backend', /ROOT_URL is http:\/\/app\.nowrinkles\.dev: plain http to an address on the open internet/);
}

async function noMockCloud(stack: SplitStack): Promise<void> {
  step('an instance in production makes no cluster on a cloud the person has no keys for, and says where to add them');
  const session = await ownerOnInstance(stack);
  const providers = (await call(`${stack.instanceUrl}/api/credentials`, { cookie: session })).body as { providers: { provider: string; configured: boolean; withoutKeys?: string }[] };
  for (const name of ['aws', 'gcp', 'azure']) {
    assert.deepEqual(providers.providers.find((entry) => entry.provider === name), wanted(name), `${name} as Cloud providers lists it`);
  }
  const asked = await call(`${stack.instanceUrl}/api/clusters`, { method: 'POST', cookie: session, body: JSON.stringify({ name: `hardening-${STAMP}`, provider: 'aws' }) });
  assert.equal(asked.status, 400, JSON.stringify(asked.body));
  assert.equal((asked.body as { error: string }).error, 'Koala has no Amazon Web Services keys of yours to make this cluster with: add your Amazon Web Services keys under Cloud providers');
  const clusters = (await call(`${stack.instanceUrl}/api/clusters`, { cookie: session })).body as { name: string }[];
  assert.ok(!clusters.some((cluster) => cluster.name.includes(`hardening-${STAMP}`)), 'a cluster was recorded anyway');
  console.log('  refused, nothing recorded; Cloud providers lists AWS, Google Cloud and Azure as wanting the person\'s own keys');

  function wanted(name: string) {
    const labels: Record<string, string> = { aws: 'Amazon Web Services', gcp: 'Google Cloud Platform', azure: 'Microsoft Azure' };
    return { provider: name, label: labels[name], configured: false, withoutKeys: 'refused' };
  }
}

async function rootNeverCallsMadeUpAddresses(stack: SplitStack, image: string): Promise<void> {
  step('a root that is not a lab starts in production on a database of its own');
  const port = await freePort();
  const rootUrl = `http://localhost:${port}`;
  const database = `koala_hardening_${STAMP}_root`;
  databases.push(database);
  const mongoUri = withDatabase(process.env.MONGO_URI || DEV_MONGO, database);
  const setupCode = randomBytes(12).toString('base64url');
  run(NAMES.root, ['--network', 'host', '--env-file', devFile('apps/backend/.env'), ...devTemporalCa(), ...envArgs({
    ROLE: 'root', PORT: String(port), PUBLIC_URL: rootUrl, MONGO_URI: mongoUri, ADMIN_SETUP_CODE: setupCode, TEMPORAL_NAMESPACE: stack.names.namespace,
    MACHINE_GATEWAY_PORT: String(await freePort()), MAIL_SMTP_URL: `smtp://127.0.0.1:${stack.ports.smtp}`, MAIL_FROM: 'koala@hardening.test',
  }), image, 'backend']);
  const logs = () => { try { return execFileSync('sh', ['-c', `docker logs --tail 40 ${NAMES.root} 2>&1`], { encoding: 'utf8' }); } catch { return ''; } };
  await until('the root answering', async () => ((await fetch(`${rootUrl}/api/identity/keys`).catch(() => undefined))?.ok ? true : undefined), logs);
  const owner = await firstAdmin(rootUrl, { suite: 'hardening', database, mongoUri, setupCode, queue: stack.names.namespace, metricsPort: 0, env: [] });

  let heard = 0;
  const listener = http.createServer((_req, res) => { heard += 1; res.end('{}'); });
  await new Promise<void>((resolveListen) => listener.listen(0, '127.0.0.1', resolveListen));
  const madeUp = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  try {
    const credential = randomBytes(24).toString('base64url');
    const db = createDatabase({ ...process.env, MONGO_URI: mongoUri });
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
        return pending?.lastError ? pending : undefined;
      }, logs);
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
  const client = new MongoClient(process.env.MONGO_URI || DEV_MONGO);
  try {
    await client.connect();
    for (const database of databases) if (database.startsWith('koala_hardening_')) await client.db(database).dropDatabase();
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  dotenv.config({ path: devFile('apps/backend/.env'), quiet: true });
  const image = buildAppImage(REPO, execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), (line) => console.log(`  ${line}`));
  try {
    await clientAddresses(image);
    await plaintextRefusals(image);
    step('a root, an instance and a hub of their own start in production containers from this commit\'s image');
    const stack = await startSplitStack();
    try {
      await noMockCloud(stack);
      await rootNeverCallsMadeUpAddresses(stack, image);
    } catch (err) {
      for (const side of ['root', 'instance'] as const) console.error(`\n── ${side}'s last lines ──\n${stack.logs(side, 40)}`);
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
