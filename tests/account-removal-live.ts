import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios from 'axios';
import { MongoClient } from 'mongodb';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { mongoTarget } from '../apps/backend/src/lib/mongo-db.js';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { ACCOUNT_DATA, removeAccountWorkflowId } from '../apps/backend/src/lib/account-removal.js';
import { createKubeRunner } from '../apps/backend/src/engine-host/sandboxes/kube.js';
import { labelValue } from '../apps/backend/src/engine-host/sandboxes/workspace.js';
import { GiteaService } from '../apps/backend/src/services/GiteaService.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';

const BASE = process.env.ACCOUNT_REMOVAL_LIVE_URL ?? 'http://localhost:3001/api';
const ADMIN = process.env.MECHANICS_ADMIN ?? process.env.GROVE_LIVE_OWNER;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let stageCount = 0;
async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  stageCount += 1;
  const started = Date.now();
  console.log(`[${stageCount}] ${name}`);
  try {
    const value = await run();
    console.log(`    ok (${Math.round((Date.now() - started) / 1000)}s)`);
    return value;
  } catch (err) {
    console.log(`    FAILED at "${name}": ${(err as Error).message}`);
    throw err;
  }
}

async function until<T>(what: string, limitMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2_000);
  }
}

async function main(): Promise<void> {
  assert.ok(ADMIN, 'set MECHANICS_ADMIN (or GROVE_LIVE_OWNER) to an admin, who invites the account this test removes');
  const db = createDatabase();
  await db.init();
  const admin = await db.getUserById(ADMIN);
  assert.ok(admin?.isAdmin, `${ADMIN} is not an admin`);
  const session = (user: { id: string; email: string }) => `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 3600)}`;
  const as = (cookie: string) => axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: cookie }, validateStatus: () => true });
  const adminHttp = as(session(admin));
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, '/tmp/kubeconfig-provisioning-lunorica');
  const target = mongoTarget(process.env);
  const mongo = await MongoClient.connect(target.uri);
  const email = `removal-live-${Date.now().toString(36)}@nowrinkles.test`;
  const password = crypto.randomBytes(18).toString('base64url');
  let ownerId = '';

  try {
    const http = await stage('a new account is invited and registered', async () => {
      const invite = (await adminHttp.post('/admin/invites')).data as { code: string };
      const registered = await axios.post(`${BASE}/auth/register`, { email, password, inviteCode: invite.code }, { proxy: false, validateStatus: () => true });
      assert.equal(registered.status, 200, JSON.stringify(registered.data));
      ownerId = (await db.getUserByEmail(email))!.id;
      return as(session({ id: ownerId, email }));
    });

    const giteaUser = await stage('it has a project with a repository and a conversation', async () => {
      const project = await http.post('/projects', { name: `removal-${Date.now().toString(36)}`, giteaRepo: `removal-${Date.now().toString(36)}`, createRepo: true });
      assert.ok(project.status < 300, JSON.stringify(project.data));
      const conversation = await http.post('/conversations', { projectId: (project.data as { id: string }).id });
      assert.ok(conversation.status < 300, JSON.stringify(conversation.data));
      const account = await db.getGiteaAccount(ownerId);
      assert.ok(account, 'the project made no Gitea user');
      console.log(`    Gitea user ${account.username}, project repository ${(project.data as { giteaOwner: string; giteaRepo: string }).giteaRepo}`);
      return account.username;
    });

    await stage('removal is refused without the email typed, then starts and signs the account out', async () => {
      assert.deepEqual((await http.get('/account/removal')).data, { email, blockers: [] });
      assert.equal((await http.delete('/account', { data: { confirm: 'nope' } })).status, 400);
      const removed = await http.delete('/account', { data: { confirm: email } });
      assert.equal(removed.status, 202, JSON.stringify(removed.data));
      assert.match(String(removed.headers['set-cookie'] ?? ''), /session=;/, 'the session cookie was not cleared');
      assert.equal((await http.get('/conversations')).status, 401, 'the old session still works');
      const login = await axios.post(`${BASE}/auth/login`, { email, password }, { proxy: false, validateStatus: () => true });
      assert.equal(login.status, 403, `signing in while being removed answered ${login.status}`);
    });

    await stage('an admin sees it going, until it is gone', async () => {
      const seen = new Set<string>();
      await until('the account to leave the list of people', 5 * 60_000, async () => {
        const people = (await adminHttp.get('/admin/people')).data.people as { id: string; removal?: { state: { state: string; done?: string[]; reason?: string } } }[];
        const entry = people.find((person) => person.id === ownerId);
        if (entry?.removal) seen.add(JSON.stringify(entry.removal.state));
        if (entry?.removal?.state.state === 'failed') throw new Error(`the removal stopped: ${entry.removal.state.reason}`);
        return entry ? undefined : true;
      });
      console.log(`    states seen: ${[...seen].join(' → ')}`);
      const result = await (await getTemporalClient()).workflow.getHandle(removeAccountWorkflowId(ownerId)).result() as { stoppedWorkflows: number; records: Record<string, number> };
      console.log(`    removed: ${JSON.stringify(result)}`);
      assert.ok((result.records.projects ?? 0) > 0 && (result.records.conversations ?? 0) > 0, 'the removal deleted none of its records');
    });

    await stage('nothing of it is left: records, repositories, workspaces', async () => {
      const left: string[] = [];
      for (const name of ACCOUNT_DATA.byOwner) {
        const count = await mongo.db(target.dbName).collection(name).countDocuments({ ownerId });
        if (count) left.push(`${name}: ${count}`);
      }
      for (const name of [...ACCOUNT_DATA.byId, ACCOUNT_DATA.last]) {
        const count = await mongo.db(target.dbName).collection(name).countDocuments({ _id: ownerId as never });
        if (count) left.push(`${name}: ${count}`);
      }
      assert.deepEqual(left, [], 'records were left behind');
      assert.equal(await gitea.userExists(giteaUser), false, `the Gitea user ${giteaUser} is still there`);
      const namespaces = await createKubeRunner()(['get', 'namespace', '-l', `koala.dev/owner=${labelValue(ownerId)}`, '-o', 'name']);
      assert.equal(namespaces.stdout.trim(), '', `workspaces are still there: ${namespaces.stdout}`);
    });

    console.log('account removal live — PASS');
  } finally {
    await mongo.close();
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
