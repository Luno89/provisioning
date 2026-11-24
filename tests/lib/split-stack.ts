import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { leaseMongo } from '../../apps/backend/src/platform/lib/mongo-lease.js';
import { parse } from 'yaml';
import { createDatabase, roleFromEnv } from '../../apps/backend/src/platform/index.js';
import { DEV, devSplitPlan, generateIdentityKey, instanceIdFor, publicKeyPem, type SplitPlace } from '../../apps/backend/src/instances/index.js';
import { registrationCodeAt } from '../../apps/backend/src/instances/testing/registration-code.js';
import { buildAppImage } from './gate-runs.js';
import { fetchSide, handOff, sessionFrom, signedInLanding } from './handoff.js';
import { devFile, devTemporalCa } from './dev-temporal.js';
import { unreachedPlatformServices } from '../../apps/backend/src/platform/testing/platform-services.js';
import { DEV_TEMPORAL_ADDRESS, firstAdmin, readySuiteNamespace, temporal, temporalCli, withDatabase, type FirstAdmin } from './suite-root.js';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { databaseSettingsFrom } from '../../apps/backend/src/platform/lib/settings.js';
import { until, waiting } from './until.js';
import type { Waiting } from '@koala/provision';
import { containerNotRunning, hostContainers } from './dead-states.js';

export const MAILPIT_IMAGE = 'axllent/mailpit:v1.21.0';
const DEV_MONGO = 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin';
const CONTAINER_TEMPORAL_CA = '/etc/koala/temporal-tls/ca.crt';
const SPLIT_PREFIX = 'koala_split_';
const REPO = fileURLToPath(new URL('../..', import.meta.url));

export type SplitSide = 'root' | 'instance';
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
    databases: { root: `${SPLIT_PREFIX}root_${stamp}`, instance: `${SPLIT_PREFIX}instance_${stamp}` },
    containers: {
      root: `nw-split-root-${stamp}`,
      instance: `nw-split-instance-${stamp}`,
      'instance-engine': `nw-split-instance-engine-${stamp}`,
      'root-host': `nw-split-root-host-${stamp}`,
      mailbox: `nw-split-mailbox-${stamp}`,
      files: `nw-split-files-${stamp}`,
    },
  };
}

export interface SplitPorts { root: number; instance: number; instanceGateway: number; rootGateway: number; smtp: number; mailApi: number; metrics: number; files: number; engineMetrics?: number }

export const splitPlace = (names: SplitNames, ports: SplitPorts): SplitPlace => ({
  rootUrl: `http://localhost:${ports.root}`,
  instanceUrl: `http://127.0.0.1:${ports.instance}`,
  rootApiPort: ports.root,
  instanceApiPort: ports.instance,
  rootDatabase: names.databases.root,
  instanceDatabase: names.databases.instance,
});

export const ownedBySplit = (database: string): boolean => database.startsWith(SPLIT_PREFIX);

export const envArgs = (env: Readonly<Record<string, string>>): string[] => Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);

export interface SplitStack {
  names: SplitNames;
  ports: SplitPorts;
  rootUrl: string;
  instanceUrl: string;
  mailpitApi: string;
  owner: FirstAdmin;
  instanceId: string;
  instanceDb: () => Promise<{ db: import('mongodb').Db; close: () => Promise<void> }>;
  logs: (process: SplitProcess, lines?: number) => Promise<string>;
  exec: (process: SplitProcess, command: string) => Promise<string>;
  restart: (process: SplitProcess) => Promise<void>;
  terminate: (workflowId: string, reason: string) => Promise<void>;
  stop: () => Promise<void>;
}

export { temporal, temporalCli, temporalContainer } from './suite-root.js';

export const answers = async (url: string): Promise<true | Waiting> => {
  const response = await fetch(url, { redirect: 'manual' }).catch((err: unknown) => err instanceof Error ? err.message : String(err));
  if (typeof response === 'string') return waiting(`${url} did not answer: ${response.slice(0, 200)}`);
  return response.status < 500 ? true : waiting(`${url} answered ${response.status}`);
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

export const minioReady = async (port: number): Promise<true | Waiting> => {
  const response = await fetch(`http://127.0.0.1:${port}/minio/health/ready`).catch((err: unknown) => err instanceof Error ? err.message : String(err));
  if (typeof response === 'string') return waiting(`MinIO on port ${port} did not answer: ${response.slice(0, 200)}`);
  return response.status === 200 ? true : waiting(`MinIO on port ${port} answered ${response.status}`);
};

export async function startSplitStack(options: { engine?: boolean; rootEnv?: (rootUrl: string) => Promise<Record<string, string>> } = {}): Promise<SplitStack> {
  dotenv.config({ path: devFile('apps/backend/.env'), quiet: true });
  const names = splitNames(Date.now().toString(36));
  const ports: SplitPorts = {
    root: await portToHandOn(), instance: await portToHandOn(),
    instanceGateway: await portToHandOn(), rootGateway: await portToHandOn(),
    smtp: await portToHandOn(), mailApi: await portToHandOn(), metrics: await portToHandOn(), files: await portToHandOn(), engineMetrics: await portToHandOn(),
  };
  const place = splitPlace(names, ports);
  const started: string[] = [];
  const mongoUri = process.env.MONGO_URI || DEV_MONGO;
  const envFile = devFile('apps/backend/.env');
  const image = await buildAppImage(REPO, execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), (line) => console.log(`  ${line}`));

  const logs = (process: SplitProcess | 'files', lines = 60): Promise<string> => hostContainers.logs(names.containers[process], lines).catch((failure: Error) => failure.message);

  const stop = async (): Promise<void> => {
    for (const container of started.reverse()) {
      await hostContainers.remove(container);
    }
    const { client, release } = await leaseMongo(mongoUri);
    try {
      for (const database of Object.values(names.databases)) if (ownedBySplit(database)) await client.db(database).dropDatabase();
    } finally {
      await release();
    }
    try { await temporal(['namespace', 'delete', '--namespace', names.namespace, '--yes']); } catch { /* never made */ }
  };

  const run = async (process: SplitProcess | 'mailbox' | 'files', args: string[]): Promise<void> => {
    await hostContainers.run(names.containers[process], args);
    started.push(names.containers[process]);
  };

  try {
    await readySuiteNamespace(names.namespace);
    await run('mailbox', ['-p', `127.0.0.1:${ports.smtp}:1025`, '-p', `127.0.0.1:${ports.mailApi}:8025`, MAILPIT_IMAGE]);
    const files = minioRun(ports.files);
    await run('files', files.args);
    await until('the instance\'s MinIO being ready', () => minioReady(ports.files), () => containerNotRunning(names.containers['files']));

    const setupCode = randomBytes(12).toString('base64url');
    const clientKey = generateIdentityKey();
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
    const backend = (process: SplitProcess, env: Record<string, string>, command = 'backend', extra: string[] = []): Promise<void> =>
      run(process, ['--network', 'host', '--restart', 'on-failure', '--env-file', envFile, ...devTemporalCa(), ...extra, ...envArgs(env), image, command]);

    const draft = (owner: { id: string; email: string }, registrationCode: string) => devSplitPlan({
      name: 'split', owner: { id: owner.id, email: owner.email, twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString() },
      instanceId: instanceIdFor(owner.id), clientKey, registrationCode,
      rootPublicKeys: publicKeyPem(signing.publicKey),
      mongoUri, now: new Date().toISOString(), place,
      temporal: { address: DEV_TEMPORAL_ADDRESS, namespace: names.namespace, ca: CONTAINER_TEMPORAL_CA }, release: { imageTag: 'split', registry: DEV.registry }, dataDir: '/app/apps/backend/data',
    });

    const rootEnv = { ...draft({ id: 'pending', email: 'pending@split.test' }, 'root-is-given-no-registration-code').rootEnv, ...shared(ports.rootGateway), ADMIN_SETUP_CODE: setupCode, ...(options.rootEnv ? await options.rootEnv(place.rootUrl) : {}) };
    await backend('root', rootEnv);
    await backend('root-host', { ...rootEnv, HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: String(ports.metrics) }, 'worker-host');
    await until('root answering', () => answers(`${place.rootUrl}/api/identity/keys`), () => containerNotRunning(names.containers['root']));

    const owner = await firstAdmin(place.rootUrl, { suite: 'split', database: names.databases.root, mongoUri: withDatabase(mongoUri, names.databases.root), setupCode, namespace: names.namespace, metricsPort: ports.metrics, env: [] });
    const rootDb = createDatabase(databaseSettingsFrom({ ...process.env, MONGO_URI: withDatabase(mongoUri, names.databases.root) }));
    await rootDb.init();
    const plan = draft(owner, await registrationCodeAt({ db: rootDb, url: place.rootUrl, signing }, { id: instanceIdFor(owner.id), ownerId: owner.id }));
    await rootDb.instances.saveInstance(plan.instance);
    await rootDb.close?.();

    await backend('instance', { ...plan.instanceEnv, ...shared(ports.instanceGateway), ...files.env, ...unreachedPlatformServices(place.instanceUrl) });
    if (options.engine) await backend('instance-engine', { ...plan.instanceEnv, ...shared(ports.instanceGateway), ...files.env, ...unreachedPlatformServices(place.instanceUrl), HEALTH_PORT: '0', TEMPORAL_ENGINE_METRICS_PORT: String(ports.engineMetrics), POD_NAME: 'instance-engine' }, 'worker-engine');
    await until('the instance answering', () => answers(`${place.instanceUrl}/api/auth/sign-in`), () => containerNotRunning(names.containers['instance']));

    const instanceDb = async () => {
      const { client, release } = await leaseMongo(withDatabase(mongoUri, names.databases.instance));
      return { db: client.db(names.databases.instance), close: release };
    };

    return {
      exec: (process, command) => hostContainers.exec(names.containers[process], ['sh', '-c', command]),
      restart: async (process) => {
        await hostContainers.restart(names.containers[process]);
        const url = process === 'root' ? place.rootUrl : process === 'instance' ? place.instanceUrl : undefined;
        if (url) await until(`${process} answering again`, () => answers(`${url}/api/auth/sign-in`), () => containerNotRunning(names.containers[process]));
      },
      terminate: async (workflowId, reason) => { await temporalCli(['workflow', 'terminate', '--namespace', names.namespace, '--workflow-id', workflowId, '--reason', reason]); },
      names, ports, rootUrl: place.rootUrl, instanceUrl: place.instanceUrl,
      mailpitApi: `http://127.0.0.1:${ports.mailApi}`, owner, instanceId: plan.instance.id,
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
    { const { location } = await root('/api/identity/go'); return location === `${stack.instanceUrl}/api/auth/oidc/start` ? true : waiting(`root sent the owner to ${location}`); }, () => containerNotRunning(stack.names.containers.instance));
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
  const set = cookies.map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?koala_sid=/.test(pair));
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, location: response.headers.get('location'), cookie: set, cookies, body };
}
