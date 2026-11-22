import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client, Connection } from '@temporalio/client';
import { buildDataConverter } from '@koala/engine-core/payloads';
import { createDatabase, type Database } from '../../apps/backend/src/platform/lib/db-interface.js';
import { loadKeys } from '../../apps/backend/src/platform/lib/keys.js';
import { temporalApiKey } from '../../apps/backend/src/platform/lib/temporal-auth.js';
import { databaseSettingsFrom } from '../../apps/backend/src/platform/lib/settings.js';
import { DEV } from '../../apps/backend/src/instances/lib/dev-root.js';
import { ClusterCommandFailed, clusterAccessOfKubeconfig, type ClusterAccess } from '../../apps/backend/src/infrastructure/services/ClusterAccess.js';
import type { Reach } from '../../apps/backend/src/infrastructure/lib/cluster-places.js';
import { fetchSide, handOff, sessionFrom } from './handoff.js';
import { signInWithPassword } from '../../apps/backend/src/accounts/services/sign-in/password-at-root.js';
import { devFile } from './dev-temporal.js';

export const DEV_KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';
export const DEV_NAMESPACE = 'nowrinkles';
export const DEV_RELEASE = 'instance';

export const devRootApi = `http://localhost:${DEV.rootApiPort}`;
export const devKoalaApi = `http://127.0.0.1:${DEV.instanceNodePort}`;

const DEV_CLUSTER = 'this computer\'s k3s';

let devReach: { access: ClusterAccess; target: Reach } | undefined;
const devCluster = (): { access: ClusterAccess; target: Reach } => {
  devReach ??= clusterAccessOfKubeconfig(readFileSync(DEV_KUBECONFIG, 'utf8'), DEV_CLUSTER);
  return devReach;
};

export const devKubectlCluster = async (...args: string[]): Promise<string> => {
  const { access, target } = devCluster();
  return (await access.kubectl(target, args)).trim();
};

export const devKubectl = (namespace: string, ...args: string[]): Promise<string> => devKubectlCluster('-n', namespace, ...args);

const kubectl = (...args: string[]): Promise<string> => devKubectl(DEV_NAMESPACE, ...args);

export interface DevPortForward {
  exited(): boolean;
  stop(): void;
}

export async function devPortForward(namespace: string, target: string, ports: string): Promise<DevPortForward> {
  const { access, target: reach } = devCluster();
  const forwarding = await access.start(reach, ['-n', namespace, 'port-forward', target, ports]);
  let ended = false;
  void forwarding.ended.then(() => { ended = true; }, () => { ended = true; });
  return { exited: () => ended, stop: () => forwarding.stop() };
}

export async function devKoalaEnv(): Promise<Record<string, string>> {
  return JSON.parse(await kubectl('get', 'configmap', `${DEV_RELEASE}-env`, '-o', 'jsonpath={.data}')) as Record<string, string>;
}

const RESULT = 'KOALA-RESULT ';

export async function devInKoala<T>(source: string): Promise<T> {
  const program = `process.chdir('/app/apps/backend');\nconst result = await (async () => {\n${source}\n})();\nconsole.log(${JSON.stringify(RESULT)} + JSON.stringify(result ?? null));\nprocess.exit(0);\n`;
  const { access, target } = devCluster();
  const said = await access.kubectl(target, ['-n', DEV_NAMESPACE, 'exec', '-i', '-c', 'backend', `deploy/${DEV_RELEASE}-backend`, '--', 'node', '--import', 'tsx', '--input-type=module'], program).catch((failure: unknown) => {
    if (failure instanceof ClusterCommandFailed) throw new Error(`running in your Koala's backend pod ended ${failure.result.code}: ${failure.result.stderr.slice(-600)}`);
    throw failure;
  });
  const line = said.split('\n').find((entry) => entry.startsWith(RESULT));
  if (!line) throw new Error(`your Koala's backend pod gave no result: ${said.slice(-600)}`);
  return JSON.parse(line.slice(RESULT.length)) as T;
}

export function devKoalaCheckout(): Promise<string> {
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
  const { cookie: rootCookie } = await signInWithPassword(devRootApi, saved);
  const handed = await handOff(fetchSide(devRootApi, rootCookie), fetchSide(devKoalaApi));
  const cookie = sessionFrom(handed.exchange.setCookies);
  assert.ok(cookie, `dev's Koala gave its owner no session: ${handed.exchange.status} ${handed.exchange.body.slice(0, 200)}`);
  const me = await fetchSide(devKoalaApi, cookie)('/api/auth/me');
  assert.equal(me.status, 200, `dev's Koala did not take its owner's session: ${me.status}`);
  const { id, email } = JSON.parse(me.body) as { id: string; email: string };
  return { id, email, cookie };
}

async function secretOf(name: string): Promise<Record<string, string>> {
  const data = JSON.parse(await kubectl('get', 'secret', name, '-o', 'jsonpath={.data}')) as Record<string, string>;
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value, 'base64').toString('utf8')]));
}

export interface DevTemporal {
  client: Client;
  close: () => Promise<void>;
}

export async function devKoalaTemporal(): Promise<DevTemporal> {
  const keys = loadKeys({ ...(await secretOf(`${DEV_RELEASE}-keys`)), NODE_ENV: 'production' });
  const ca = (await secretOf(`${DEV_RELEASE}-temporal-tls`))['ca.crt'];
  assert.ok(ca, `the Secret ${DEV_RELEASE}-temporal-tls holds no ca.crt`);
  const service = `${DEV_RELEASE}-temporal`;
  const address = await kubectl('get', 'service', service, '-o', 'jsonpath={.spec.clusterIP}');
  const namespace = (await devKoalaEnv()).TEMPORAL_NAMESPACE;
  assert.ok(namespace, 'dev\'s Koala names no TEMPORAL_NAMESPACE');
  const connection = await Connection.connect({
    address: `${address}:7233`,
    tls: { serverRootCACertificate: Buffer.from(ca), serverNameOverride: service },
    apiKey: temporalApiKey(keys.temporal, { subject: 'koala-live-suite', namespace, role: 'read' }),
  });
  return { client: new Client({ connection, namespace, dataConverter: buildDataConverter(keys.payload) }), close: () => connection.close() };
}

export async function devKoalaDatabase(): Promise<Database> {
  const keys = await secretOf(`${DEV_RELEASE}-keys`);
  const address = await kubectl('get', 'service', `${DEV_RELEASE}-mongo`, '-o', 'jsonpath={.spec.clusterIP}');
  const used = await kubectl('get', 'deployment', `${DEV_RELEASE}-backend`, '-o', 'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="MONGO_URI")].value}');
  const database = new URL(used.replace(/^mongodb:/, 'http:')).pathname.slice(1);
  assert.ok(database, 'dev\'s Koala names no database in its MONGO_URI');
  return createDatabase(databaseSettingsFrom({
    ...keys,
    MONGO_URI: `mongodb://admin:${encodeURIComponent(keys.MONGO_ROOT_PASSWORD!)}@${address}:27017/${database}?authSource=admin&directConnection=true`,
  }));
}
