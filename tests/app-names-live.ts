import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { signUp } from './lib/sign-up.js';

const run = promisify(execFile);
const ROOT = process.env.APP_NAMES_LIVE_ROOT ?? 'http://localhost:3001';
const ADMIN = process.env.MECHANICS_ADMIN ?? process.env.GROVE_LIVE_OWNER;
const CLUSTER = 'provisioning-lunorica';
const KUBECONFIG = `/tmp/kubeconfig-${CLUSTER}`;
const KUBECTL = fileURLToPath(new URL('../bin/kubectl', import.meta.url));
const NAME = `shop-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Deployment { id: string; name: string; namespace?: string; status: string; ownerId?: string }

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

const client = (cookie?: string): AxiosInstance => axios.create({ baseURL: ROOT, proxy: false, maxRedirects: 0, headers: cookie ? { Cookie: cookie } : {}, validateStatus: () => true });
const sessionOf = (headers: Record<string, unknown>): string | undefined => ([] as string[]).concat((headers['set-cookie'] as string[] | undefined) ?? []).map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('session='));
const kubectl = async (...args: string[]) => (await run(KUBECTL, args, { env: { ...process.env, KUBECONFIG } })).stdout.trim();

const mine = async (api: AxiosInstance): Promise<Deployment[]> => (await api.get('/api/deployments')).data as Deployment[];

async function deploy(api: AxiosInstance, who: string): Promise<Deployment> {
  const made = await api.post('/api/deployments', { name: NAME, clusterId: CLUSTER, appType: 'audiobookshelf', strategy: 'native' });
  assert.equal(made.status, 202, `${who}'s deploy answered ${made.status}: ${JSON.stringify(made.data)}`);
  const id = (made.data as { id: string }).id;
  assert.notEqual(id, NAME, `${who}'s deployment id is its name`);
  return until(`${who}'s ${NAME} running`, async () => {
    const found = (await mine(api)).find((entry) => entry.id === id);
    if (!found) throw new Hopeless(`${who}'s deployment is gone from the list`);
    if (found.status === 'failed') throw new Hopeless(`${who}'s app failed to deploy`);
    return found.status === 'running' ? found : undefined;
  });
}

async function destroy(api: AxiosInstance, id: string): Promise<void> {
  const gone = await api.delete(`/api/deployments/${id}`);
  if (gone.status >= 300 && gone.status !== 404) console.log(`    destroying ${id} answered ${gone.status}: ${JSON.stringify(gone.data)}`);
  await until(`${id} gone`, async () => ((await mine(api)).some((entry) => entry.id === id) ? undefined : true));
}

async function main(): Promise<void> {
  assert.ok(ADMIN, 'set MECHANICS_ADMIN (or GROVE_LIVE_OWNER) to an admin, who deploys one app and invites the other owner');
  const db = createDatabase();
  await db.init();
  const admin = await db.accounts.getUserById(ADMIN);
  assert.ok(admin?.isAdmin, `${ADMIN} is not an admin`);
  const adminHttp = client(`session=${signJWT({ userId: admin.id, email: admin.email }, loadKeys(process.env).session, 3600)}`);
  const email = `app-names-live-${Date.now().toString(36)}@nowrinkles.test`;
  const password = crypto.randomBytes(18).toString('base64url');
  let other: AxiosInstance | undefined;
  let otherId: string | undefined;
  const deployed: { api: AxiosInstance; id: string }[] = [];

  try {
    await stage('a second owner signs up with the admin\'s invite', async () => {
      const invite = (await adminHttp.post('/api/admin/invites')).data as { code: string };
      const registered = await signUp(`${ROOT}/api`, { email, password, inviteCode: invite.code });
      assert.equal(registered.status, 200, registered.error);
      const login = await client().post('/api/auth/login', { email, password });
      const cookie = sessionOf(login.headers);
      assert.ok(login.status === 200 && cookie, JSON.stringify(login.data));
      other = client(cookie);
      otherId = (await other.get('/api/auth/me')).data.id as string;
    });

    const [first, second] = await stage(`both owners deploy an app called ${NAME} on the system cluster, and both run`, async () => {
      const a = await deploy(adminHttp, 'the admin');
      deployed.push({ api: adminHttp, id: a.id });
      const b = await deploy(other!, 'the other owner');
      deployed.push({ api: other!, id: b.id });
      return [a, b];
    });

    await stage('each has its own namespace on the cluster, and each owner sees only their own', async () => {
      assert.ok(first.namespace && second.namespace, 'a deployment has no namespace recorded');
      assert.notEqual(first.namespace, second.namespace, 'the two apps share a namespace');
      assert.match(first.namespace!, new RegExp(`^${NAME}-[a-f0-9]{6}$`));
      assert.match(second.namespace!, new RegExp(`^${NAME}-[a-f0-9]{6}$`));
      const namespaces = (await kubectl('get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}')).split(/\s+/);
      assert.ok(namespaces.includes(first.namespace!), `${first.namespace} is not on the cluster`);
      assert.ok(namespaces.includes(second.namespace!), `${second.namespace} is not on the cluster`);
      assert.deepEqual((await mine(adminHttp)).filter((entry) => entry.name === NAME).map((entry) => entry.id), [first.id]);
      assert.deepEqual((await mine(other!)).filter((entry) => entry.name === NAME).map((entry) => entry.id), [second.id]);
    });

    await stage('deploying it again as the same owner goes to the same app, not a second one', async () => {
      const again = await other!.post('/api/deployments', { name: NAME, clusterId: CLUSTER, appType: 'audiobookshelf', strategy: 'native' });
      assert.equal(again.status, 202, JSON.stringify(again.data));
      assert.equal((again.data as { id: string }).id, second.id);
      await until('the redeploy running', async () => {
        const found = (await mine(other!)).find((entry) => entry.id === second.id);
        if (!found) throw new Hopeless('the redeployed app is gone from the list');
        if (found.status === 'failed') throw new Hopeless('the redeploy failed');
        return found.status === 'running' ? found : undefined;
      });
      assert.equal((await mine(other!)).filter((entry) => entry.name === NAME).length, 1);
    });

    console.log('\napp names live — PASS');
  } finally {
    for (const { api, id } of deployed) await destroy(api, id).catch((err) => console.log(`    could not destroy ${id}: ${(err as Error).message}`));
    if (other && otherId) {
      const removed = await other.delete('/api/account', { data: { confirm: email } });
      if (removed.status === 202) {
        for (let tries = 0; tries < 150 && await db.accounts.getUserById(otherId); tries += 1) await sleep(2_000);
        console.log((await db.accounts.getUserById(otherId)) ? `    ${email} is still being removed` : '    removed the test account');
      } else {
        console.log(`    removing ${email} answered ${removed.status}: ${JSON.stringify(removed.data)}`);
      }
    }
    await db.close();
  }
}

main().catch((err) => {
  console.error(`\napp names live — FAIL: ${(err as Error).message}`);
  process.exit(1);
});
