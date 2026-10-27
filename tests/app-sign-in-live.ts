import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';

const run = promisify(execFile);
const ROOT = process.env.APP_SIGN_IN_LIVE_ROOT ?? 'http://localhost:3001';
const ADMIN = process.env.MECHANICS_ADMIN ?? process.env.GROVE_LIVE_OWNER;
const CLUSTER = 'provisioning-lunorica';
const KUBECONFIG = `/tmp/kubeconfig-${CLUSTER}`;
const KUBECTL = fileURLToPath(new URL('../bin/kubectl', import.meta.url));
const NAME = `hermes-${Date.now().toString(36)}`;
const LOCAL_PORT = 19119;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Deployment { id: string; name: string; namespace?: string; status: string; [field: string]: unknown }
interface SignIn { describe: string; login?: string; password: string }

let stageCount = 0;
async function stage<T>(name: string, work: () => Promise<T>): Promise<T> {
  stageCount += 1;
  const started = Date.now();
  console.log(`[${stageCount}] ${name}`);
  try {
    const value = await work();
    console.log(`    ok (${Math.round((Date.now() - started) / 1000)}s)`);
    return value;
  } catch (err) {
    console.log(`    FAILED at "${name}": ${(err as Error).message}`);
    throw err;
  }
}

class Hopeless extends Error {}

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  let last = '';
  for (let tries = 0; ; tries += 1) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      if (err instanceof Hopeless) throw err;
      last = (err as Error).message;
    }
    if (tries > 0 && tries % 12 === 0) console.log(`    still waiting for ${what}${last ? ` (${last.slice(0, 200)})` : ''}`);
    await sleep(5000);
  }
}

const client = (cookie: string): AxiosInstance => axios.create({ baseURL: ROOT, proxy: false, maxRedirects: 0, headers: { Cookie: cookie }, validateStatus: () => true });
const kubectl = async (...args: string[]) => (await run(KUBECTL, args, { env: { ...process.env, KUBECONFIG } })).stdout.trim();
const mine = async (api: AxiosInstance): Promise<Deployment[]> => (await api.get('/api/deployments')).data as Deployment[];

async function main(): Promise<void> {
  assert.ok(ADMIN, 'set MECHANICS_ADMIN (or GROVE_LIVE_OWNER) to an admin, who deploys the app on the system cluster');
  const db = createDatabase();
  await db.init();
  const admin = await db.accounts.getUserById(ADMIN);
  await db.close();
  assert.ok(admin?.isAdmin, `${ADMIN} is not an admin`);
  const api = client(`session=${signJWT({ userId: admin.id, email: admin.email }, loadKeys(process.env).session, 3600)}`);
  let id: string | undefined;
  let forward: ReturnType<typeof spawn> | undefined;

  try {
    const deployed = await stage(`a Hermes, ${NAME}, deploys on the system cluster with a password Koala made for it`, async () => {
      const made = await api.post('/api/deployments', { name: NAME, clusterId: CLUSTER, appType: 'hermes', strategy: 'native' });
      assert.equal(made.status, 202, `the deploy answered ${made.status}: ${JSON.stringify(made.data)}`);
      id = (made.data as { id: string }).id;
      return until(`${NAME} running`, async () => {
        const found = (await mine(api)).find((entry) => entry.id === id);
        if (!found) throw new Hopeless('the deployment is gone from the list');
        if (found.status === 'failed') throw new Hopeless('the app failed to deploy');
        return found.status === 'running' ? found : undefined;
      });
    });
    const namespace = deployed.namespace ?? NAME;

    const signIn = await stage('Show sign-in gives its owner the dashboard\'s login, never cached, and the listing carries no password', async () => {
      const asked = await api.get(`/api/deployments/${id}/sign-in`);
      assert.equal(asked.status, 200, `the sign-in answered ${asked.status}: ${JSON.stringify(asked.data)}`);
      assert.equal(asked.headers['cache-control'], 'no-store');
      const [entry] = (asked.data as { signIns: SignIn[] }).signIns;
      assert.ok(entry && entry.login === 'admin' && entry.password.length >= 32, `the sign-in is not a generated one: ${JSON.stringify(asked.data)}`);
      assert.notEqual(entry.password, 'hermes123');
      const listed = JSON.stringify(await mine(api));
      assert.ok(!listed.includes(entry.password), 'the listing carries the password');
      assert.ok(!listed.includes('hermesDashboardPassword'), 'the listing names the sealed field');
      console.log(`    ${entry.describe}: ${entry.login} and a ${entry.password.length}-character password`);
      return entry;
    });

    await stage('the app\'s Deployment holds no password, only where to read it', async () => {
      const spec = await kubectl('-n', namespace, 'get', 'deployment', 'hermes', '-o', 'json');
      assert.ok(!spec.includes(signIn.password), 'the Deployment carries the password');
      const env = (JSON.parse(spec) as { spec: { template: { spec: { containers: { env: { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string } } }[] }[] } } } })
        .spec.template.spec.containers[0]!.env;
      const password = env.find((entry) => entry.name === 'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD');
      assert.equal(password?.value, undefined);
      assert.equal(password?.valueFrom?.secretKeyRef?.name, 'hermes-secrets');
    });

    await stage('the dashboard signs in its password, and refuses the old default and anyone not signed in', async () => {
      forward = spawn(KUBECTL, ['-n', namespace, 'port-forward', 'svc/hermes', `${LOCAL_PORT}:9119`], { env: { ...process.env, KUBECONFIG }, stdio: 'ignore' });
      const hermes = axios.create({ baseURL: `http://127.0.0.1:${LOCAL_PORT}`, proxy: false, validateStatus: () => true, timeout: 10_000 });
      const providers = await until('the dashboard answering through the port-forward', async () => {
        const answer = await hermes.get('/api/auth/providers');
        return answer.status === 200 ? answer.data as unknown : undefined;
      });
      const listed = JSON.stringify(providers);
      const provider = /"(?:id|name)":"(basic[^"]*)"/.exec(listed)?.[1] ?? 'basic';
      const signedOut = (await hermes.get('/api/auth/me')).status;
      const login = (password: string) => hermes.post('/auth/password-login', { provider, username: signIn.login, password });
      const old = await login('hermes123');
      const own = await login(signIn.password);
      const cookies = ([] as string[]).concat((own.headers['set-cookie'] as string[] | undefined) ?? []).map((line) => line.split(';')[0]!).join('; ');
      const me = (await hermes.get('/api/auth/me', { headers: { Cookie: cookies } })).status;
      console.log(`    signed out /api/auth/me ${signedOut} · admin/hermes123 ${old.status} · its password ${own.status}, then /api/auth/me ${me} (provider ${provider})`);
      assert.equal(signedOut, 401, 'the dashboard answered someone not signed in');
      assert.equal(old.status, 401, 'the dashboard let in the old default');
      assert.equal(own.status, 200, `the dashboard refused the password Koala made for it: ${JSON.stringify(own.data)}`);
      assert.equal(me, 200, 'the session the password made does not open the dashboard');
    });
  } finally {
    forward?.kill();
    if (id) {
      await stage(`${NAME} destroyed`, async () => {
        const gone = await api.delete(`/api/deployments/${id}`);
        if (gone.status >= 300 && gone.status !== 404) console.log(`    destroying answered ${gone.status}: ${JSON.stringify(gone.data)}`);
        await until(`${NAME} gone`, async () => ((await mine(api)).some((entry) => entry.id === id) ? undefined : true));
      });
    }
  }
  console.log('\npassed');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
