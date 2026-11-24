import { execFileSync } from 'node:child_process';
import { hostContainers } from './dead-states.js';
import { pinnedImage } from './pinned-image.js';
import { randomBytes } from 'node:crypto';
import { leaseMongo } from '../../apps/backend/src/platform/lib/mongo-lease.js';
import { signInWithPassword } from '../../apps/backend/src/accounts/services/sign-in/password-at-root.js';

export interface SuiteRoot {
  suite: string;
  database: string;
  mongoUri: string;
  setupCode: string;
  namespace: string;
  metricsPort: number;
  env: string[];
}

export interface FirstAdmin {
  id: string;
  email: string;
  password: string;
  cookie: string;
}

export function withDatabase(uri: string, database: string): string {
  const match = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/.exec(uri);
  if (!match) throw new Error(`not a MongoDB URI: ${uri}`);
  return `${match[1]}/${database}${match[3] ?? ''}`;
}

export function suiteRoot(suite: string, metricsPort: number): SuiteRoot {
  const stamp = Date.now().toString(36);
  const database = `koala_${suite.replace(/-/g, '_')}_${stamp}`;
  const base = process.env.MONGO_URI?.trim();
  if (!base) throw new Error(`${suite} makes its root a database of its own beside MONGO_URI, which is not set: run it with the dev stack's apps/backend/.env, which names it`);
  const mongoUri = withDatabase(base, database);
  const setupCode = randomBytes(12).toString('base64url');
  const namespace = `${suite}-${stamp}`;
  return {
    suite, database, mongoUri, setupCode, namespace, metricsPort,
    env: [
      '-e', 'ROLE=root', '-e', `MONGO_URI=${mongoUri}`, '-e', `ADMIN_SETUP_CODE=${setupCode}`, '-e', 'CERTIFICATES=internal',
      '-e', `TEMPORAL_CONNECTION_ADDRESS=${DEV_TEMPORAL_ADDRESS}`, '-e', `TEMPORAL_NAMESPACE=${namespace}`, '-e', 'TERRAFORM_STATE=local', '-e', 'DATA_DIR=/app/apps/backend/data', '-e', `HEADSCALE_URL=${DEV_HEADSCALE}`,
    ],
  };
}

export const DEV_TEMPORAL_ADDRESS = '127.0.0.1:7233';

export const DEV_HEADSCALE = 'http://127.0.0.1:8080';

export const rootIdentity = (publicUrl: string, release: { tag: string; registry: string }): string[] =>
  ['-e', `PUBLIC_URL=${publicUrl}`, '-e', `APP_URL=${publicUrl}`, '-e', `INSTANCE_IMAGE_TAG=${release.tag}`, '-e', `INSTANCE_REGISTRY=${release.registry}`];

export const workerEnv = (root: SuiteRoot): string[] =>
  ['-e', 'HEALTH_PORT=0', '-e', `TEMPORAL_METRICS_PORT=${root.metricsPort}`];

export async function firstAdmin(rootUrl: string, root: SuiteRoot): Promise<FirstAdmin> {
  const email = `${root.suite}-owner-${Date.now().toString(36)}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const post = (path: string, body: unknown) => fetch(`${rootUrl}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const registered = await post('/auth/register', { email, password, inviteCode: root.setupCode });
  if (registered.status !== 200) throw new Error(`the first admin could not sign up on ${rootUrl}: ${registered.status} ${await registered.text()}`);
  const { cookie } = await signInWithPassword(rootUrl, { email, password });
  const me = await fetch(`${rootUrl}/api/auth/me`, { headers: { cookie } });
  const body = await me.json() as { id?: string; email?: string; error?: string };
  if (me.status !== 200 || !body.id || !body.email) throw new Error(`the first admin signed in on ${rootUrl} but root does not read it: ${me.status} ${body.error ?? ''}`);
  return { id: body.id, email: body.email, password, cookie };
}

export async function forgetMeshUser(ownerId: string): Promise<void> {
  const headscale = (...args: string[]): Promise<string> => hostContainers.exec('provisioning-headscale', ['headscale', ...args]);
  const name = `platform-${ownerId}`;
  try {
    const nodes = JSON.parse(await headscale('nodes', 'list', '-o', 'json')) as Array<{ id: number; user?: { name?: string } }>;
    for (const node of nodes.filter((entry) => entry.user?.name === name)) await headscale('nodes', 'delete', '-i', String(node.id), '--force');
    const users = JSON.parse(await headscale('users', 'list', '-o', 'json')) as Array<{ id: number; name: string }>;
    const user = users.find((entry) => entry.name === name);
    if (user) await headscale('users', 'destroy', '--identifier', String(user.id), '--force');
  } catch { /* never joined */ }
}

export async function logoutDeliveries(root: SuiteRoot): Promise<Array<{ url: string; attempts: number; lastError?: string }>> {
  const { client, release } = await leaseMongo(root.mongoUri);
  try {
    return (await client.db(root.database).collection('logoutDeliveries').find({}).toArray()).map((doc) => ({ url: String(doc.url), attempts: Number(doc.attempts ?? 0), ...(doc.lastError ? { lastError: String(doc.lastError) } : {}) }));
  } finally {
    await release();
  }
}

export async function temporalContainer(): Promise<string> {
  const name = (await hostContainers.named('label=com.docker.compose.service=temporal'))[0];
  if (!name) throw new Error('the dev stack\'s Temporal is not running');
  return name;
}

export const temporalCli = async (args: string[]): Promise<string> =>
  hostContainers.runToEnd(['--network', `container:${await temporalContainer()}`, pinnedImage('temporalio/admin-tools'), 'temporal', ...args, '--address', '127.0.0.1:7236']);

export const temporal = (args: string[]): Promise<string> => temporalCli(['operator', ...args]);

export async function makeSuiteNamespace(root: SuiteRoot): Promise<void> {
  await temporal(['namespace', 'create', '--namespace', root.namespace, '--retention', '24h']);
}

export async function dropSuiteNamespace(root: SuiteRoot): Promise<void> {
  try { await temporal(['namespace', 'delete', '--namespace', root.namespace, '--yes']); } catch { /* never made */ }
}

export async function dropSuiteDatabase(root: SuiteRoot): Promise<void> {
  if (!root.database.startsWith('koala_')) throw new Error(`${root.database} is not a suite's database`);
  const { client, release } = await leaseMongo(root.mongoUri);
  try {
    await client.db(root.database).dropDatabase();
  } finally {
    await release();
  }
}
