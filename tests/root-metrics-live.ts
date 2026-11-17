import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { COLLECTOR_VALUES } from '../packages/cdktf-infra/constructs/telemetry-values.js';
import { excerptEnv, scriptExcerpt } from './coupling/shell-trace.js';
import { until } from './lib/until.js';
import { containerNotRunning, startedContainerStopped } from './lib/dead-states.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = 'koala-root-metrics-live';
const COLLECTOR_IMAGE = /image: (otel\/opentelemetry-collector-contrib:[0-9.]+)/.exec(readFileSync(join(REPO, 'docker-compose.otel.yml'), 'utf8'))![1]!;
const CONTAINERS = { cluster: `${PROJECT}-cluster-collector`, host: `${PROJECT}-host-collector` };
const CLUSTER_OTLP = 14317;
const CLUSTER_METRICS = 18889;
const SERVICES = ['caddy', 'mongo', 'postgres', 'temporal', 'headscale', 'registry', 'mail'];
const OWN_PORTS = [4317, 4318, 9216, 9187, 5005, 2525, CLUSTER_OTLP, CLUSTER_METRICS];
const scratch = mkdtempSync(join(tmpdir(), `${PROJECT}-`));
const composeEnv = join(scratch, '.env');
const standIns = join(scratch, 'stand-ins.yml');
const backups = join(scratch, 'backups');

const run = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) });
const COMPOSE = join(REPO, 'bin/docker-compose');
const compose = (...args: string[]) => run(COMPOSE, ['-p', PROJECT, '--env-file', composeEnv, '-f', standIns, '-f', join(REPO, 'docker-compose.exporters.yml'), ...args]);
const step = (message: string) => console.log(`\n▶ ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Service { ports?: string[]; volumes?: string[]; container_name?: string; healthcheck?: unknown }
const serviceOf = (file: string, name: string): Service => (parse(readFileSync(join(REPO, file), 'utf8')) as { services: Record<string, Service> }).services[name]!;
const without = (service: Service, keep: (port: string) => boolean): Service => {
  const { volumes: _volumes, container_name: _name, ...rest } = service;
  const ports = (service.ports ?? []).filter(keep);
  return { ...rest, ...(ports.length ? { ports } : { ports: [] }) };
};

function teardown(): void {
  for (const name of Object.values(CONTAINERS)) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  spawnSync(COMPOSE, ['-p', PROJECT, '--env-file', composeEnv, '-f', standIns, '-f', join(REPO, 'docker-compose.exporters.yml'), 'down', '-v', '--remove-orphans'], { cwd: REPO, stdio: 'ignore' });
}

const telemetryShell = (then: string) => {
  const script = join(REPO, 'scripts/root-node/root-telemetry.sh');
  const names = readFileSync(script, 'utf8').split('\n').filter((line) => /^(MONGO_USER|POSTGRES_ROLE)=/.test(line)).join('\n');
  const said = spawnSync('bash', ['-c', scriptExcerpt(script, ['put', 'setting', 'kept_secret', 'mongo_monitor', 'postgres_monitor'], [
    'set -euo pipefail', names, 'die() { echo "refused: $1" >&2; exit 1; }', then,
  ].join('\n'))], { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...excerptEnv() } });
  if (said.status !== 0) throw new Error(`root-telemetry.sh refused: ${said.stderr}`);
  return said.stdout;
};

const setting = (key: string): string => new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(composeEnv, 'utf8'))![1]!;

async function series(): Promise<string> {
  return (await fetch(`http://127.0.0.1:${CLUSTER_METRICS}/metrics`)).text();
}

const valueOf = (text: string, name: string, labels: Record<string, string>): number | undefined => {
  for (const line of text.split('\n')) {
    const found = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{(.*)\} (\S+)$/.exec(line);
    if (!found || found[1] !== name) continue;
    if (Object.entries(labels).every(([key, value]) => found[2]!.includes(`${key}="${value}"`))) return Number(found[3]);
  }
  return undefined;
};

const seen = (name: string, labels: Record<string, string>, wanted?: number) => until(`${name}${JSON.stringify(labels)}${wanted === undefined ? '' : ` = ${wanted}`}`, async () => {
  const value = valueOf(await series(), name, labels);
  if (value === undefined) return undefined;
  return wanted === undefined || value === wanted ? value : undefined;
}, () => startedContainerStopped(Object.values(CONTAINERS)));

const mongosh = (container: string, script: string) => spawnSync('docker', ['exec', '-i', container, 'mongosh', '--quiet', 'mongodb://127.0.0.1:27017/admin?directConnection=true'], { input: script, encoding: 'utf8' });

function listening(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end('220 koala test\r\n'));
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main(): Promise<void> {
  step('nothing else on this computer holds the ports root\'s metrics use');
  const taken = run('ss', ['-ltnH']).split('\n').map((line) => line.split(/\s+/)[3] ?? '').filter((address) => OWN_PORTS.some((port) => address.endsWith(`:${port}`)));
  assert.deepEqual(taken, [], `these ports are taken, so this suite cannot run beside what holds them: ${taken.join(', ')}`);

  step('root\'s own Mongo, Postgres and registry, as their compose files define them, without the host ports the dev stack holds');
  teardown();
  writeFileSync(composeEnv, `MONGO_ROOT_PASSWORD=${run('openssl', ['rand', '-hex', '24']).trim()}\n`, { mode: 0o600 });
  writeFileSync(standIns, stringify({
    services: {
      mongodb: without(serviceOf('docker-compose.mongo.yml', 'mongodb'), () => false),
      postgresql: without(serviceOf('docker-compose.temporal.yml', 'postgresql'), () => false),
      'registry-writer': without(serviceOf('docker-compose.registry.yml', 'registry-writer'), (port) => port.endsWith(':5002')),
    },
  }));
  run(COMPOSE, ['-p', PROJECT, '--env-file', composeEnv, '-f', standIns, 'up', '-d', '--wait']);
  const mongo = `${PROJECT}-mongodb-1`;
  const postgres = `${PROJECT}-postgresql-1`;
  const initiated = mongosh(mongo, [
    `db.getSiblingDB('admin').auth('admin', '${setting('MONGO_ROOT_PASSWORD')}');`,
    "try { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] }); } catch (e) { if (e.codeName !== 'AlreadyInitialized') throw e; }",
  ].join('\n'));
  assert.equal(initiated.status, 0, initiated.stderr);
  await until('Mongo to be its replica set\'s primary', async () => (mongosh(mongo, `db.getSiblingDB('admin').auth('admin', '${setting('MONGO_ROOT_PASSWORD')}'); print(db.hello().isWritablePrimary)`).stdout.includes('true') ? true : undefined), () => containerNotRunning(mongo));

  step('root-telemetry.sh makes Mongo\'s and Postgres\'s monitoring accounts, their passwords kept in the compose env and printed nowhere');
  const made = telemetryShell([
    `ENV=${composeEnv}`,
    `mongo_monitor ${mongo} "$(setting MONGO_ROOT_PASSWORD "$ENV")" "$(kept_secret MONGO_EXPORTER_PASSWORD "$ENV")"`,
    `postgres_monitor ${postgres} "$(kept_secret POSTGRES_EXPORTER_PASSWORD "$ENV")"`,
    'echo made',
  ].join('\n'));
  assert.equal(made.trim(), 'made');
  for (const key of ['MONGO_EXPORTER_PASSWORD', 'POSTGRES_EXPORTER_PASSWORD']) {
    assert.match(setting(key), /^[0-9a-f]{48}$/);
    assert.ok(!made.includes(setting(key)), `${key} was printed`);
  }

  step('the monitoring accounts may watch and nothing more');
  const mongoWrite = mongosh(mongo, `db.getSiblingDB('admin').auth('koala-metrics', '${setting('MONGO_EXPORTER_PASSWORD')}'); print(db.getSiblingDB('admin').serverStatus().ok); db.getSiblingDB('provisioning').things.insertOne({ a: 1 });`);
  assert.match(mongoWrite.stdout, /(^|> )1$/m, `koala-metrics could not read serverStatus: ${mongoWrite.stdout}${mongoWrite.stderr}`);
  assert.match(mongoWrite.stdout + mongoWrite.stderr, /not authorized/, 'koala-metrics could write to Mongo');
  run('docker', ['exec', '-i', postgres, 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'temporal', '-d', 'temporal'], 'CREATE TABLE executions (id int);\n');
  const asMonitor = (sql: string) => spawnSync('docker', ['exec', '-i', '-e', `PGPASSWORD=${setting('POSTGRES_EXPORTER_PASSWORD')}`, postgres, 'psql', '-h', '127.0.0.1', '-v', 'ON_ERROR_STOP=1', '-U', 'koala_metrics', '-d', 'temporal', '-tA'], { input: sql, encoding: 'utf8' });
  assert.equal(asMonitor('SELECT count(*) > 0 FROM pg_stat_activity;\n').stdout.trim(), 't');
  assert.match(asMonitor('SELECT * FROM executions;\n').stderr, /permission denied for table executions/);
  assert.match(asMonitor('CREATE ROLE intruder;\n').stderr, /permission denied to create role/);

  step('the exporters start from docker-compose.exporters.yml, on loopback only');
  compose('up', '-d', 'mongodb-exporter', 'postgres-exporter');
  for (const port of [9216, 9187, 5005]) {
    const addresses = run('ss', ['-ltnH', `( sport = :${port} )`]).split('\n').map((line) => line.split(/\s+/)[3]).filter(Boolean);
    assert.ok(addresses.length > 0 && addresses.every((address) => address!.startsWith('127.0.0.1:')), `port ${port} listens on ${addresses.join(' ')}`);
  }

  step('a stand-in for the cluster\'s collector, with the cluster\'s own metrics pipeline, and root\'s host collector with its real config');
  mkdirSync(backups, { recursive: true, mode: 0o755 });
  const { alternateConfig } = COLLECTOR_VALUES;
  const clusterConfig = {
    receivers: alternateConfig.receivers,
    processors: alternateConfig.processors,
    exporters: { prometheus: alternateConfig.exporters.prometheus },
    service: { pipelines: { metrics: alternateConfig.service.pipelines.metrics } },
  };
  writeFileSync(join(scratch, 'cluster.yaml'), stringify(clusterConfig), { mode: 0o644 });
  run('docker', ['run', '-d', '--name', CONTAINERS.cluster, '-p', `127.0.0.1:${CLUSTER_OTLP}:4317`, '-p', `127.0.0.1:${CLUSTER_METRICS}:8889`, '-v', `${join(scratch, 'cluster.yaml')}:/c.yaml:ro`, COLLECTOR_IMAGE, '--config=/c.yaml']);
  run('docker', ['run', '-d', '--name', CONTAINERS.host, '--network', 'host', '-e', `OTEL_CLUSTER_COLLECTOR=127.0.0.1:${CLUSTER_OTLP}`,
    '-v', `${join(REPO, 'docker/otel/config.yaml')}:/etc/otelcol/config.yaml:ro`, '-v', `${backups}:/koala-backup:ro`, COLLECTOR_IMAGE, '--config=/etc/otelcol/config.yaml']);

  step('every service on root has its up series in the cluster\'s collector, labelled with its service name');
  for (const service of SERVICES) console.log(`  up{service="${service}"} = ${await seen('up', { service })}`);
  await seen('up', { service: 'mongo', job: 'koala-mongo' }, 1);
  await seen('up', { service: 'postgres', job: 'koala-postgres' }, 1);
  await seen('up', { service: 'registry', instance: '127.0.0.1:5005' }, 1);
  await seen('mongodb_up', { service: 'mongo' }, 1);
  await seen('pg_up', { service: 'postgres' }, 1);
  await seen('up', { service: 'mail', job: 'koala-mail' }, 0);
  console.log('  Mongo and Postgres answer their exporters, which read them as their monitoring accounts; the registry serves its own');

  step('mail is up while its port answers, and down again once it stops');
  const mail = await listening(2525);
  await seen('up', { service: 'mail' }, 1);
  await new Promise((resolve) => mail.close(resolve));
  await seen('up', { service: 'mail' }, 0);

  step('backup.sh records its success, which arrives as koala_root_backup_last_success_seconds and stays');
  const at = Math.floor(Date.now() / 1000);
  const recorded = spawnSync('bash', ['-c', scriptExcerpt(join(REPO, 'scripts/root-node/backup.sh'), ['record_success'], `set -eu\nrecord_success ${backups} ${at}`)], { encoding: 'utf8', env: { ...process.env, ...excerptEnv() } });
  assert.equal(recorded.status, 0, recorded.stderr);
  await seen('koala_root_backup_last_success_seconds', { job: 'koala-backup' }, at);
  await sleep(70_000);
  assert.equal(valueOf(await series(), 'koala_root_backup_last_success_seconds', { job: 'koala-backup' }), at, 'the backup\'s last success expired from the cluster\'s collector');
  console.log('  still there past the cluster collector\'s one-minute expiry, read again on every poll');

  step('a stopped Mongo shows as down through its exporter');
  compose('stop', 'mongodb');
  await seen('mongodb_up', { service: 'mongo' }, 0);

  console.log('\nroot metrics live — PASS');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    teardown();
    rmSync(scratch, { recursive: true, force: true });
  });
