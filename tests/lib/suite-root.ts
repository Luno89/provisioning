import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';

const DEV_MONGO = 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin';

export interface SuiteRoot {
  suite: string;
  database: string;
  mongoUri: string;
  setupCode: string;
  queue: string;
  metricsPort: number;
  env: string[];
}

export interface FirstAdmin {
  id: string;
  email: string;
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
  const mongoUri = withDatabase(process.env.MONGO_URI || DEV_MONGO, database);
  const setupCode = randomBytes(12).toString('base64url');
  const queue = `${suite}-${stamp}`;
  return {
    suite, database, mongoUri, setupCode, queue, metricsPort,
    env: ['-e', `MONGO_URI=${mongoUri}`, '-e', `ADMIN_SETUP_CODE=${setupCode}`, '-e', `POOL_TASK_QUEUE=${queue}`],
  };
}

export const workerEnv = (root: SuiteRoot): string[] =>
  ['-e', `TEMPORAL_TASK_QUEUE=${root.queue}`, '-e', 'HEALTH_PORT=0', '-e', `TEMPORAL_METRICS_PORT=${root.metricsPort}`];

export async function firstAdmin(rootUrl: string, root: SuiteRoot): Promise<FirstAdmin> {
  const email = `${root.suite}-owner-${Date.now().toString(36)}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const post = (path: string, body: unknown) => fetch(`${rootUrl}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const registered = await post('/auth/register', { email, password, inviteCode: root.setupCode });
  if (registered.status !== 200) throw new Error(`the first admin could not sign up on ${rootUrl}: ${registered.status} ${await registered.text()}`);
  const signedIn = await post('/auth/login', { email, password });
  const body = await signedIn.json() as { user?: { id: string; email: string }; error?: string };
  if (signedIn.status !== 200 || !body.user) throw new Error(`the first admin could not sign in on ${rootUrl}: ${signedIn.status} ${body.error ?? ''}`);
  const cookie = signedIn.headers.getSetCookie().map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?session=/.test(pair));
  if (!cookie) throw new Error(`signing in on ${rootUrl} set no session cookie`);
  return { id: body.user.id, email: body.user.email, cookie };
}

export function forgetMeshUser(ownerId: string): void {
  const headscale = (...args: string[]) => execFileSync('docker', ['exec', 'provisioning-headscale', 'headscale', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const name = `platform-${ownerId}`;
  try {
    const nodes = JSON.parse(headscale('nodes', 'list', '-o', 'json')) as Array<{ id: number; user?: { name?: string } }>;
    for (const node of nodes.filter((entry) => entry.user?.name === name)) headscale('nodes', 'delete', '-i', String(node.id), '--force');
    const users = JSON.parse(headscale('users', 'list', '-o', 'json')) as Array<{ id: number; name: string }>;
    const user = users.find((entry) => entry.name === name);
    if (user) headscale('users', 'destroy', '--identifier', String(user.id), '--force');
  } catch { /* never joined */ }
}

export async function dropSuiteDatabase(root: SuiteRoot): Promise<void> {
  if (!root.database.startsWith('koala_')) throw new Error(`${root.database} is not a suite's database`);
  const client = new MongoClient(root.mongoUri);
  try {
    await client.connect();
    await client.db(root.database).dropDatabase();
  } finally {
    await client.close();
  }
}
