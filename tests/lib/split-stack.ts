import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { createDatabase, roleFromEnv } from '../../apps/backend/src/platform/index.js';
import { devSplitPlan, hashCredential, instanceIdFor, publicKeyPem, type SplitPlace } from '../../apps/backend/src/instances/index.js';
import { buildAppImage } from './gate-runs.js';
import { fetchSide, handOff, sessionFrom, signedInLanding } from './handoff.js';
import { devDataMounts, devFile, devTemporalCa } from './dev-temporal.js';
import { firstAdmin, withDatabase, type FirstAdmin } from './suite-root.js';

export const MAILPIT_IMAGE = 'axllent/mailpit:v1.21.0';
const DEV_MONGO = 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin';
const SPLIT_PREFIX = 'koala_split_';
const REPO = fileURLToPath(new URL('../..', import.meta.url));

export type SplitSide = 'root' | 'instance' | 'hub';
export type SplitProcess = SplitSide | 'instance-engine' | 'root-host';

export interface SplitNames {
  stamp: string;
  namespace: string;
  databases: Record<SplitSide, string>;
  containers: Record<SplitProcess | 'mailbox', string>;
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
    },
  };
}

export interface SplitPorts { root: number; instance: number; hub: number; instanceGateway: number; rootGateway: number; hubGateway: number; smtp: number; mailApi: number; metrics: number; engineMetrics?: number }

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
  stop: () => Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('no port'))));
    });
  });
}

const docker = (args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function temporalContainer(): string {
  const name = docker(['ps', '--filter', 'label=com.docker.compose.service=temporal', '--format', '{{.Names}}']).split('\n')[0];
  if (!name) throw new Error('the dev stack\'s Temporal is not running');
  return name;
}

export const temporal = (args: string[]): string => docker(['exec', temporalContainer(), 'temporal', 'operator', ...args, '--address', '127.0.0.1:7236']);

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

export const answers = async (url: string): Promise<true | undefined> => {
  const response = await fetch(url, { redirect: 'manual' }).catch(() => undefined);
  return response && response.status < 500 ? true : undefined;
};

const DEV_KUBECONFIG = '/tmp/kubeconfig-provisioning-lunorica';
const GITEA_SECRETS = ['.gitea-admin-password'];

function devGitea(): { url: string; mounts: string[] } {
  const kubectl = (args: string[]) => execFileSync(devFile('bin/kubectl'), ['--kubeconfig', DEV_KUBECONFIG, ...args], { encoding: 'utf8' }).trim();
  const port = kubectl(['-n', 'gitea', 'get', 'svc', 'gitea-http', '-o', 'jsonpath={.spec.ports[0].nodePort}']);
  const host = kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}']).split(/\s+/)[0];
  if (!port || !host) throw new Error('the dev stack\'s Gitea has no address this suite can find');
  return {
    url: `http://${host}:${port}`,
    mounts: devDataMounts(GITEA_SECRETS),
  };
}

export async function startSplitStack(options: { engine?: boolean; hubGitea?: boolean } = {}): Promise<SplitStack> {
  dotenv.config({ path: devFile('apps/backend/.env'), quiet: true });
  const names = splitNames(Date.now().toString(36));
  const ports: SplitPorts = {
    root: await freePort(), instance: await freePort(), hub: await freePort(),
    instanceGateway: await freePort(), rootGateway: await freePort(), hubGateway: await freePort(),
    smtp: await freePort(), mailApi: await freePort(), metrics: await freePort(), engineMetrics: await freePort(),
  };
  const place = splitPlace(names, ports);
  const started: string[] = [];
  const mongoUri = process.env.MONGO_URI || DEV_MONGO;
  const envFile = devFile('apps/backend/.env');
  const image = buildAppImage(REPO, execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), (line) => console.log(`  ${line}`));

  const logs = (process: SplitProcess, lines = 60): string => {
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

  const run = (process: SplitProcess | 'mailbox', args: string[]): void => {
    docker(['run', '-d', '--name', names.containers[process], ...args]);
    started.push(names.containers[process]);
  };

  try {
    temporal(['namespace', 'create', '--namespace', names.namespace, '--retention', '24h']);
    run('mailbox', ['-p', `127.0.0.1:${ports.smtp}:1025`, '-p', `127.0.0.1:${ports.mailApi}:8025`, MAILPIT_IMAGE]);

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
    });
    const backend = (process: SplitProcess, env: Record<string, string>, command = 'backend', extra: string[] = []): void =>
      run(process, ['--network', 'host', '--restart', 'on-failure', '--env-file', envFile, ...devTemporalCa(), ...extra, ...envArgs(env), image, command]);

    const draft = (owner: { id: string; email: string }) => devSplitPlan({
      name: 'split', owner: { id: owner.id, email: owner.email, twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString() },
      instanceId: instanceIdFor(owner.id), credential: instanceCredential, credentialHash: hashCredential(instanceCredential),
      hubCredential, hubCredentialHash: hashCredential(hubCredential), rootPublicKeys: publicKeyPem(signing.publicKey),
      mongoUri, now: new Date().toISOString(), place,
    });

    const rootEnv = { ...draft({ id: 'pending', email: 'pending@split.test' }).rootEnv, ...shared(ports.rootGateway), ADMIN_SETUP_CODE: setupCode };
    backend('root', rootEnv);
    backend('root-host', { ...rootEnv, HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: String(ports.metrics) }, 'worker-host');
    await until('root answering', () => answers(`${place.rootUrl}/api/identity/keys`), () => logs('root'));

    const owner = await firstAdmin(place.rootUrl, { suite: 'split', database: names.databases.root, mongoUri: withDatabase(mongoUri, names.databases.root), setupCode, queue: names.namespace, metricsPort: ports.metrics, env: [] });
    const plan = draft(owner);
    const rootDb = createDatabase({ ...process.env, MONGO_URI: withDatabase(mongoUri, names.databases.root) });
    await rootDb.init();
    await rootDb.instances.saveInstance(plan.instance);
    await rootDb.close?.();

    backend('instance', { ...plan.instanceEnv, ...shared(ports.instanceGateway) });
    if (options.engine) backend('instance-engine', { ...plan.instanceEnv, ...shared(ports.instanceGateway), HEALTH_PORT: '0', TEMPORAL_ENGINE_METRICS_PORT: String(ports.engineMetrics) }, 'worker-engine');
    const gitea = options.hubGitea ? devGitea() : undefined;
    backend('hub', { ...plan.hubEnv, ...shared(ports.hubGateway), ...(gitea ? { GITEA_URL: gitea.url } : {}) }, 'backend', gitea?.mounts ?? []);
    await until('the instance answering', () => answers(`${place.instanceUrl}/api/auth/sign-in`), () => logs('instance'));
    await until('the hub answering', () => answers(`${place.hubUrl}/api/auth/sign-in`), () => logs('hub'));
    const asOwner = fetchSide(place.rootUrl, owner.cookie);
    await until('the hub naming its sign-in key to root', async () =>
      ((await asOwner('/api/identity/go?to=hub')).location === `${place.hubUrl}/api/auth/oidc/start` ? true : undefined), () => logs('hub'));

    const instanceDb = async () => {
      const client = new MongoClient(withDatabase(mongoUri, names.databases.instance));
      await client.connect();
      return { db: client.db(names.databases.instance), close: () => client.close() };
    };

    return {
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
    ((await root('/api/identity/go')).location === `${stack.instanceUrl}/api/auth/oidc/start` ? true : undefined), () => stack.logs('instance'));
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
