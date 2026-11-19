import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client, Connection } from '@temporalio/client';
import { buildDataConverter } from '@koala/engine-core/payloads';
import { createDatabase, type Database } from '../../apps/backend/src/platform/lib/db-interface.js';
import { loadKeys } from '../../apps/backend/src/platform/lib/keys.js';
import { temporalApiKey } from '../../apps/backend/src/platform/lib/temporal-auth.js';
import { databaseSettingsFrom } from '../../apps/backend/src/platform/lib/settings.js';
import { DEV, devGiteaOnThisComputer } from '../../apps/backend/src/instances/lib/dev-root.js';
import { succeeded } from '@koala/engine-core/processes';
import type { KoalasCluster } from '../../apps/backend/src/engine-host/sandboxes/kube.js';
import { fetchSide, handOff, sessionFrom } from './handoff.js';
import { devFile } from './dev-temporal.js';
import { here } from './processes.js';

export const DEV_KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';
export const DEV_NAMESPACE = 'nowrinkles';
export const DEV_RELEASE = 'instance';

export const devRootApi = `http://localhost:${DEV.rootApiPort}`;
export const devKoalaApi = `http://127.0.0.1:${DEV.instanceNodePort}`;
export const devGiteaUrl = devGiteaOnThisComputer;
export const devDataDir = new URL('../../apps/backend/data', import.meta.url).pathname;

const kubectl = (...args: string[]): string =>
  execFileSync('k3s', ['kubectl', '--kubeconfig', DEV_KUBECONFIG, '-n', DEV_NAMESPACE, ...args], { encoding: 'utf8' }).trim();

export const devKubectl = async (namespace: string, ...args: string[]): Promise<string> =>
  (await succeeded(here, { command: 'k3s', args: ['kubectl', '--kubeconfig', DEV_KUBECONFIG, '-n', namespace, ...args] })).trim();

export const devKubectlCluster = async (...args: string[]): Promise<string> =>
  (await succeeded(here, { command: 'k3s', args: ['kubectl', '--kubeconfig', DEV_KUBECONFIG, ...args] })).trim();

export const devPortForward = (namespace: string, target: string, ports: string): ChildProcess =>
  spawn('k3s', ['kubectl', '--kubeconfig', DEV_KUBECONFIG, '-n', namespace, 'port-forward', target, ports], { stdio: 'ignore' });

export function devKoalaEnv(): Record<string, string> {
  return JSON.parse(kubectl('get', 'configmap', `${DEV_RELEASE}-env`, '-o', 'jsonpath={.data}')) as Record<string, string>;
}

export function devRegistry(): { pull: string; push: string } {
  const pull = devKoalaEnv().KOALA_REGISTRY;
  assert.ok(pull, 'dev\'s Koala names no KOALA_REGISTRY its cluster pulls images from');
  return { pull, push: new URL(devGiteaUrl).host };
}

const RESULT = 'KOALA-RESULT ';

export async function devInKoala<T>(source: string): Promise<T> {
  const program = `process.chdir('/app/apps/backend');\nconst result = await (async () => {\n${source}\n})();\nconsole.log(${JSON.stringify(RESULT)} + JSON.stringify(result ?? null));\nprocess.exit(0);\n`;
  const ran = await here.run({ command: 'k3s', args: ['kubectl', '--kubeconfig', DEV_KUBECONFIG, '-n', DEV_NAMESPACE, 'exec', '-i', '-c', 'backend', `deploy/${DEV_RELEASE}-backend`, '--', 'node', '--import', 'tsx', '--input-type=module'], input: program });
  if (ran.code !== 0) throw new Error(`running in your Koala's backend pod ended ${ran.code}: ${ran.stderr.slice(-600)}`);
  const said = ran.stdout;
  const line = said.split('\n').find((entry) => entry.startsWith(RESULT));
  if (!line) throw new Error(`your Koala's backend pod gave no result: ${said.slice(-600)}`);
  return JSON.parse(line.slice(RESULT.length)) as T;
}

export function devKoalaCheckout(): string {
  return kubectl('get', 'deployment', `${DEV_RELEASE}-backend`, '-o', 'jsonpath={.spec.template.spec.volumes[?(@.name=="source")].hostPath.path}');
}

export interface DevOwner {
  id: string;
  email: string;
  cookie: string;
}

export const devRootPage = `http://${DEV.rootHost}.localhost:${DEV.rootWebPort}`;
export const devKoalaPage = `http://${DEV.instanceName}.localhost:${DEV.instanceWebPort}`;

export const DEV_OWNER_FILE = 'apps/backend/data/dev/owner.json';

export const devOwnerSignIn = (): { email: string; password: string } =>
  JSON.parse(readFileSync(devFile(DEV_OWNER_FILE), 'utf8')) as { email: string; password: string };

export async function devOwner(): Promise<DevOwner> {
  const saved = devOwnerSignIn();
  const rootIn = await fetchSide(devRootApi)('/api/auth/login', { method: 'POST', body: saved });
  assert.equal(rootIn.status, 200, `dev's owner could not sign in at root: ${rootIn.status} ${rootIn.body.slice(0, 200)}`);
  const rootCookie = sessionFrom(rootIn.setCookies);
  assert.ok(rootCookie, 'signing in at root set no session cookie');
  const handed = await handOff(fetchSide(devRootApi, rootCookie), fetchSide(devKoalaApi));
  const cookie = sessionFrom(handed.exchange.setCookies);
  assert.ok(cookie, `dev's Koala gave its owner no session: ${handed.exchange.status} ${handed.exchange.body.slice(0, 200)}`);
  const me = await fetchSide(devKoalaApi, cookie)('/api/auth/me');
  assert.equal(me.status, 200, `dev's Koala did not take its owner's session: ${me.status}`);
  const { id, email } = JSON.parse(me.body) as { id: string; email: string };
  return { id, email, cookie };
}

function secretOf(name: string): Record<string, string> {
  const data = JSON.parse(kubectl('get', 'secret', name, '-o', 'jsonpath={.data}')) as Record<string, string>;
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value, 'base64').toString('utf8')]));
}

export interface DevTemporal {
  client: Client;
  close: () => Promise<void>;
}

export async function devKoalaTemporal(): Promise<DevTemporal> {
  const keys = loadKeys({ ...secretOf(`${DEV_RELEASE}-keys`), NODE_ENV: 'production' });
  const ca = secretOf(`${DEV_RELEASE}-temporal-tls`)['ca.crt'];
  assert.ok(ca, `the Secret ${DEV_RELEASE}-temporal-tls holds no ca.crt`);
  const service = `${DEV_RELEASE}-temporal`;
  const address = kubectl('get', 'service', service, '-o', 'jsonpath={.spec.clusterIP}');
  const namespace = devKoalaEnv().TEMPORAL_NAMESPACE;
  assert.ok(namespace, 'dev\'s Koala names no TEMPORAL_NAMESPACE');
  const connection = await Connection.connect({
    address: `${address}:7233`,
    tls: { serverRootCACertificate: Buffer.from(ca), serverNameOverride: service },
    apiKey: temporalApiKey(keys.temporal, { subject: 'koala-live-suite', namespace, role: 'read' }),
  });
  return { client: new Client({ connection, namespace, dataConverter: buildDataConverter(keys.payload) }), close: () => connection.close() };
}

export function devKoalaDatabase(): Database {
  const keys = secretOf(`${DEV_RELEASE}-keys`);
  const address = kubectl('get', 'service', `${DEV_RELEASE}-mongo`, '-o', 'jsonpath={.spec.clusterIP}');
  const used = kubectl('get', 'deployment', `${DEV_RELEASE}-backend`, '-o', 'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="MONGO_URI")].value}');
  const database = new URL(used.replace(/^mongodb:/, 'http:')).pathname.slice(1);
  assert.ok(database, 'dev\'s Koala names no database in its MONGO_URI');
  return createDatabase(databaseSettingsFrom({
    ...keys,
    MONGO_URI: `mongodb://admin:${encodeURIComponent(keys.MONGO_ROOT_PASSWORD!)}@${address}:27017/${database}?authSource=admin&directConnection=true`,
  }));
}

export function devKoalasCluster(): KoalasCluster {
  return { start: (args, io) => Promise.resolve(here.start({ command: 'k3s', args: ['kubectl', '--kubeconfig', DEV_KUBECONFIG, ...args] }, io)) };
}
