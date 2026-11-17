import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { parse } from 'yaml';
import { createDatabase, roleFromEnv } from '../../apps/backend/src/platform/index.js';
import { DEV, devSplitPlan, hashCredential, instanceIdFor, publicKeyPem, type SplitPlace } from '../../apps/backend/src/instances/index.js';
import { buildAppImage } from './gate-runs.js';
import { fetchSide, handOff, sessionFrom, signedInLanding } from './handoff.js';
import { devFile, devTemporalCa } from './dev-temporal.js';
import { unreachedPlatformServices } from '../../apps/backend/src/platform/testing/platform-services.js';
import { DEV_TEMPORAL_ADDRESS, firstAdmin, temporal, temporalContainer, withDatabase, type FirstAdmin } from './suite-root.js';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { databaseSettingsFrom } from '../../apps/backend/src/platform/lib/settings.js';
import { until } from './until.js';
import { containerNotRunning } from './dead-states.js';

export const MAILPIT_IMAGE = 'axllent/mailpit:v1.21.0';
const DEV_MONGO = 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin';
const CONTAINER_TEMPORAL_CA = '/etc/koala/temporal-tls/ca.crt';
const SPLIT_PREFIX = 'koala_split_';
const REPO = fileURLToPath(new URL('../..', import.meta.url));

export type SplitSide = 'root' | 'instance' | 'hub';
export type SplitProcess = SplitSide | 'instance-engine' | 'root-host';

export interface SplitNames {
  stamp: string;
  namespace: string;
  databases: Record<SplitSide, string>;
  containers: Record<SplitProcess | 'mailbox' | 'files', string>;
}

export function splitNames(stamp: string): SplitNames {
  return {
    stamp,
    namespace: `split-${stamp}`,
    databases: { root: `${SPLIT_PREFIX}root_${stamp}`, instance: `${SPLIT_PREFIX}instance_${stamp}`, hub: `${SPLIT_PREFIX}hub_${stamp}` },
    containers: {
      root: `nw-split-root-${stamp}`,
      instance: `nw-split-instance-${stamp}`,
      hub: `nw-split-hub-${stamp}`,
      'instance-engine': `nw-split-instance-engine-${stamp}`,
      'root-host': `nw-split-root-host-${stamp}`,
      mailbox: `nw-split-mailbox-${stamp}`,
      files: `nw-split-files-${stamp}`,
    },
  };
}

export interface SplitPorts { root: number; instance: number; hub: number; instanceGateway: number; rootGateway: number; hubGateway: number; smtp: number; mailApi: number; metrics: number; files: number; engineMetrics?: number }

export const splitPlace = (names: SplitNames, ports: SplitPorts): SplitPlace => ({
  rootUrl: `http://localhost:${ports.root}`,
  instanceUrl: `http://localhost:${ports.instance}`,
  hubUrl: `http://localhost:${ports.hub}`,
  rootApiPort: ports.root,
  instanceApiPort: ports.instance,
  hubApiPort: ports.hub,
  rootDatabase: names.databases.root,
  hubDatabase: names.databases.hub,
  instanceDatabase: names.databases.instance,
});

export const ownedBySplit = (database: string): boolean => database.startsWith(SPLIT_PREFIX);

export const sharedProjectDatabases = (ids: readonly unknown[]): string[] =>
  ids.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{24}$/.test(id)).map((id) => `hub_${id}`);

export const envArgs = (env: Readonly<Record<string, string>>): string[] => Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);

export interface SplitStack {
  names: SplitNames;
  ports: SplitPorts;
  rootUrl: string;
  instanceUrl: string;
  hubUrl: string;
  mailpitApi: string;
  owner: FirstAdmin;
  instanceId: string;
  instanceCredential: string;
  instanceDb: () => Promise<{ db: import('mongodb').Db; close: () => Promise<void> }>;
  logs: (process: SplitProcess, lines?: number) => string;
  exec: (process: SplitProcess, command: string) => string;
  restart: (process: SplitProcess) => Promise<void>;
  terminate: (workflowId: string, reason: string) => void;
  stop: () => Promise<void>;
}

const docker = (args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export { temporal, temporalContainer } from './suite-root.js';

export const answers = async (url: string): Promise<true | undefined> => {
  const response = await fetch(url, { redirect: 'manual' }).catch(() => undefined);
  return response && response.status < 500 ? true : undefined;
};

export const MINIO_BUCKET = 'koala';

export function chartMinioImage(): string {
  const values = parse(readFileSync(fileURLToPath(new URL('../../charts/instance/values.yaml', import.meta.url)), 'utf8')) as { minio?: { image?: unknown } };
  const image = values.minio?.image;
  if (typeof image !== 'string' || !image) throw new Error('charts/instance/values.yaml names no minio.image');
  return image;
}

export interface MinioEnv { MINIO_ENDPOINT: string; MINIO_ROOT_USER: string; MINIO_ROOT_PASSWORD: string; MINIO_BUCKET: string }

export function minioRun(port: number): { args: string[]; env: MinioEnv } {
  const user = randomBytes(15).toString('base64url');
  const password = randomBytes(30).toString('base64url');
  return {
    args: ['-p', `127.0.0.1:${port}:9000`, '-e', 'MINIO_BROWSER=off', '-e', `MINIO_ROOT_USER=${user}`, '-e', `MINIO_ROOT_PASSWORD=${password}`, chartMinioImage(), 'server', '/data'],
    env: { MINIO_ENDPOINT: `127.0.0.1:${port}`, MINIO_ROOT_USER: user, MINIO_ROOT_PASSWORD: password, MINIO_BUCKET },
  };
}

export const minioReady = async (port: number): Promise<true | undefined> => {
  const response = await fetch(`http://127.0.0.1:${port}/minio/health/ready`).catch(() => undefined);
  return response?.status === 200 ? true : undefined;
};

export async function startSplitStack(options: { engine?: boolean; rootEnv?: (rootUrl: string) => Promise<Record<string, string>> } = {}): Promise<SplitStack> {
  dotenv.config({ path: devFile('apps/backend/.env'), quiet: true });
  const names = splitNames(Date.now().toString(36));
  const ports: SplitPorts = {
    root: await portToHandOn(), instance: await portToHandOn(), hub: await portToHandOn(),
    instanceGateway: await portToHandOn(), rootGateway: await portToHandOn(), hubGateway: await portToHandOn(),
    smtp: await portToHandOn(), mailApi: await portToHandOn(), metrics: await portToHandOn(), files: await portToHandOn(), engineMetrics: await portToHandOn(),
  };
  const place = splitPlace(names, ports);
  const started: string[] = [];
  const mongoUri = process.env.MONGO_URI || DEV_MONGO;
  const envFile = devFile('apps/backend/.env');
  const image = buildAppImage(REPO, execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), (line) => console.log(`  ${line}`));

  const logs = (process: SplitProcess | 'files', lines = 60): string => {
    try {
      return execFileSync('docker', ['logs', '--tail', String(lines), names.containers[process]], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const failed = err as { stdout?: string; stderr?: string };
      return `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
    }
  };

  const stop = async (): Promise<void> => {
    for (const container of started.reverse()) {
      try { docker(['rm', '-f', container]); } catch { /* gone */ }
    }
    const client = new MongoClient(mongoUri);
    try {
      await client.connect();
      const shared = await client.db(names.databases.hub).collection('shared_projects').find({}, { projection: { _id: 1 } }).toArray();
      for (const database of sharedProjectDatabases(shared.map((doc) => doc._id))) await client.db(database).dropDatabase();
      for (const database of Object.values(names.databases)) if (ownedBySplit(database)) await client.db(database).dropDatabase();
    } finally {
      await client.close();
    }
    try { temporal(['namespace', 'delete', '--namespace', names.namespace, '--yes']); } catch { /* never made */ }
  };

  const run = (process: SplitProcess | 'mailbox' | 'files', args: string[]): void => {
    docker(['run', '-d', '--name', names.containers[process], ...args]);
    started.push(names.containers[process]);
  };

  try {
    temporal(['namespace', 'create', '--namespace', names.namespace, '--retention', '24h']);
    run('mailbox', ['-p', `127.0.0.1:${ports.smtp}:1025`, '-p', `127.0.0.1:${ports.mailApi}:8025`, MAILPIT_IMAGE]);
    const files = minioRun(ports.files);
    run('files', files.args);
    await until('the instance\'s MinIO being ready', () => minioReady(ports.files), () => containerNotRunning(names.containers['files']));

    const setupCode = randomBytes(12).toString('base64url');
    const instanceCredential = randomBytes(32).toString('base64url');
    const hubCredential = randomBytes(32).toString('base64url');
    const signing = roleFromEnv({ ...process.env, ROLE: 'root' }).signing;
    if (!signing) throw new Error('the dev env holds no ROOT_IDENTITY_KEY for root to sign with');

    const shared = (gateway: number): Record<string, string> => ({
      TEMPORAL_NAMESPACE: names.namespace,
      MACHINE_GATEWAY_PORT: String(gateway),
      MAIL_SMTP_URL: `smtp://127.0.0.1:${ports.smtp}`,
      MAIL_FROM: 'koala@split.test',
      WATCH_UNREACHABLE_MINUTES: '1',
      CERTIFICATES: 'internal',
    });
    const backend = (process: SplitProcess, env: Record<string, string>, command = 'backend', extra: string[] = []): void =>
      run(process, ['--network', 'host', '--restart', 'on-failure', '--env-file', envFile, ...devTemporalCa(), ...extra, ...envArgs(env), image, command]);

    const draft = (owner: { id: string; email: string }) => devSplitPlan({
      name: 'split', owner: { id: owner.id, email: owner.email, twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString() },
      instanceId: instanceIdFor(owner.id), credential: instanceCredential, credentialHash: hashCredential(instanceCredential),
      hubCredential, hubCredentialHash: hashCredential(hubCredential), rootPublicKeys: publicKeyPem(signing.publicKey),
      mongoUri, now: new Date().toISOString(), place,
      temporal: { address: DEV_TEMPORAL_ADDRESS, namespace: names.namespace, ca: CONTAINER_TEMPORAL_CA }, release: { imageTag: 'split', registry: DEV.registry }, dataDir: '/app/apps/backend/data',
    });

    const rootEnv = { ...draft({ id: 'pending', email: 'pending@split.test' }).rootEnv, ...shared(ports.rootGateway), ADMIN_SETUP_CODE: setupCode, ...(options.rootEnv ? await options.rootEnv(place.rootUrl) : {}) };
    backend('root', rootEnv);
    backend('root-host', { ...rootEnv, HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: String(ports.metrics) }, 'worker-host');
    await until('root answering', () => answers(`${place.rootUrl}/api/identity/keys`), () => containerNotRunning(names.containers['root']));

    const owner = await firstAdmin(place.rootUrl, { suite: 'split', database: names.databases.root, mongoUri: withDatabase(mongoUri, names.databases.root), setupCode, namespace: names.namespace, metricsPort: ports.metrics, env: [] });
    const plan = draft(owner);
    const rootDb = createDatabase(databaseSettingsFrom({ ...process.env, MONGO_URI: withDatabase(mongoUri, names.databases.root) }));
    await rootDb.init();
    await rootDb.instances.saveInstance(plan.instance);
    await rootDb.close?.();

    backend('instance', { ...plan.instanceEnv, ...shared(ports.instanceGateway), ...files.env, ...unreachedPlatformServices(place.instanceUrl) });
    if (options.engine) backend('instance-engine', { ...plan.instanceEnv, ...shared(ports.instanceGateway), ...files.env, ...unreachedPlatformServices(place.instanceUrl), HEALTH_PORT: '0', TEMPORAL_ENGINE_METRICS_PORT: String(ports.engineMetrics) }, 'worker-engine');
    backend('hub', { ...plan.hubEnv, ...shared(ports.hubGateway), ...unreachedPlatformServices(place.hubUrl) });
    await until('the instance answering', () => answers(`${place.instanceUrl}/api/auth/sign-in`), () => containerNotRunning(names.containers['instance']));
    await until('the hub answering', () => answers(`${place.hubUrl}/api/auth/sign-in`), () => containerNotRunning(names.containers['hub']));
    const asOwner = fetchSide(place.rootUrl, owner.cookie);
    await until('the hub naming its sign-in key to root', async () =>
      ((await asOwner('/api/identity/go?to=hub')).location === `${place.hubUrl}/api/auth/oidc/start` ? true : undefined), () => containerNotRunning(names.containers['hub']));

    const instanceDb = async () => {
      const client = new MongoClient(withDatabase(mongoUri, names.databases.instance));
      await client.connect();
      return { db: client.db(names.databases.instance), close: () => client.close() };
    };

    return {
      exec: (process, command) => docker(['exec', names.containers[process], 'sh', '-c', command]),
      restart: async (process) => {
        docker(['restart', names.containers[process]]);
        const url = process === 'root' ? place.rootUrl : process === 'instance' ? place.instanceUrl : process === 'hub' ? place.hubUrl : undefined;
        if (url) await until(`${process} answering again`, () => answers(`${url}/api/auth/sign-in`), () => containerNotRunning(names.containers[process]));
      },
      terminate: (workflowId, reason) => { docker(['exec', temporalContainer(), 'temporal', 'workflow', 'terminate', '--namespace', names.namespace, '--workflow-id', workflowId, '--reason', reason, '--address', '127.0.0.1:7236']); },
      names, ports, rootUrl: place.rootUrl, instanceUrl: place.instanceUrl, hubUrl: place.hubUrl,
      mailpitApi: `http://127.0.0.1:${ports.mailApi}`, owner, instanceId: plan.instance.id, instanceCredential,
      instanceDb, logs, stop,
    };
  } catch (err) {
    if (process.env.SPLIT_LIVE_KEEP) console.error(`kept for a look: ${started.join(' ')}; databases ${Object.values(names.databases).join(' ')}; namespace ${names.namespace}`);
    else await stop().catch(() => undefined);
    throw err;
  }
}

export async function ownerOnInstance(stack: SplitStack): Promise<string> {
  const root = fetchSide(stack.rootUrl, stack.owner.cookie);
  await until('root sending the owner to the instance\'s OpenID sign-in', async () =>
    ((await root('/api/identity/go')).location === `${stack.instanceUrl}/api/auth/oidc/start` ? true : undefined), () => containerNotRunning(stack.names.containers.instance));
  const handed = await handOff(root, fetchSide(stack.instanceUrl), '/api/identity/go');
  const session = sessionFrom(handed.exchange.setCookies);
  if (!signedInLanding(handed.exchange) || !session) throw new Error(`the instance did not sign its owner in: ${handed.exchange.status} ${handed.exchange.body.slice(0, 300)}`);
  return session;
}

export interface Answer { status: number; location: string | null; cookie: string | undefined; cookies: string[]; body: unknown }

export async function call(url: string, init: RequestInit & { cookie?: string | undefined } = {}): Promise<Answer> {
  const { cookie, headers, ...rest } = init;
  const response = await fetch(url, {
    redirect: 'manual',
    ...rest,
    headers: { ...(headers as Record<string, string> | undefined), ...(cookie ? { Cookie: cookie } : {}), ...(rest.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const cookies = response.headers.getSetCookie();
  const set = cookies.map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?session=/.test(pair));
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, location: response.headers.get('location'), cookie: set, cookies, body };
}
