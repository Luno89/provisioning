import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { signUp } from './lib/sign-up.js';

const ROOT = process.env.ROUTES_LIVE_ROOT ?? 'http://localhost:3001';
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

const client = (cookie?: string): AxiosInstance => axios.create({ baseURL: ROOT, proxy: false, maxRedirects: 0, headers: cookie ? { Cookie: cookie } : {}, validateStatus: () => true });
const sessionOf = (headers: Record<string, unknown>): string | undefined => ([] as string[]).concat((headers['set-cookie'] as string[] | undefined) ?? []).map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('session='));

type Probe = { method?: 'get' | 'post'; path: string; body?: unknown };

const SIGNED_IN: Probe[] = [
  { path: '/api/account/removal' },
  { path: '/api/actions' },
  { path: '/api/admin/invites' },
  { path: '/api/agents' },
  { path: '/api/app-schemas/odoo' },
  { path: '/api/artifacts/storage' },
  { path: '/api/auth/me' },
  { path: '/api/auto-mode' },
  { path: '/api/binding-types' },
  { path: '/api/branches' },
  { path: '/api/cluster-access' },
  { path: '/api/cluster-providers' },
  { path: '/api/clusters' },
  { path: '/api/conversations' },
  { path: '/api/credentials' },
  { path: '/api/deployments' },
  { path: '/api/documents/no-such-workspace' },
  { path: '/api/egress/requests' },
  { path: '/api/engine/extensions' },
  { path: '/api/engine-tools' },
  { path: '/api/evals/level2/bench' },
  { path: '/api/files/servers' },
  { path: '/api/hub/projects' },
  { path: '/api/identity/keys' },
  { path: '/api/infrastructure' },
  { path: '/api/instance-addresses' },
  { path: '/api/instances/name-check?name=routeslive' },
  { path: '/api/instance-trial' },
  { method: 'post', path: '/api/items/story/no-such-story/chat', body: {} },
  { path: '/api/leaves' },
  { path: '/api/logs/cluster/no-such-cluster' },
  { method: 'post', path: '/api/machines/join', body: { code: 'no-such-code' } },
  { path: '/api/mcp/servers' },
  { path: '/api/memories' },
  { path: '/api/mesh/config' },
  { path: '/api/mesh/local-agents' },
  { path: '/api/models/rate-limits' },
  { path: '/api/modules' },
  { path: '/api/monitoring' },
  { path: '/api/nginx/config' },
  { path: '/api/notifications' },
  { path: '/api/pending-approvals' },
  { path: '/api/plans' },
  { path: '/api/procedures' },
  { path: '/api/projects' },
  { path: '/api/project-sharing/no-such-project' },
  { path: '/api/registry/search?q=routes' },
  { path: '/api/release-settings/options' },
  { path: '/api/running' },
  { path: '/api/secret-requests' },
  { path: '/api/share/no-such-token' },
  { path: '/api/temporal/status' },
  { path: '/api/trees' },
  { path: '/api/tree-types' },
  { path: '/api/turns' },
  { path: '/api/vps-catalog' },
  { path: '/api/worker' },
  { path: '/api/workspace-dependencies' },
];

const unmounted = (answer: AxiosResponse): boolean => answer.status === 404 && typeof answer.data === 'string' && /Cannot (GET|POST)/.test(answer.data);

async function main(): Promise<void> {
  assert.ok(ADMIN, 'set MECHANICS_ADMIN (or GROVE_LIVE_OWNER) to an admin, who invites this test\'s account');
  const db = createDatabase();
  await db.init();
  const admin = await db.accounts.getUserById(ADMIN);
  assert.ok(admin?.isAdmin, `${ADMIN} is not an admin`);
  const adminHttp = client(`session=${signJWT({ userId: admin.id, email: admin.email }, loadKeys(process.env).session, 3600)}`);
  const email = `routes-live-${Date.now().toString(36)}@nowrinkles.test`;
  const password = crypto.randomBytes(18).toString('base64url');
  let me: AxiosInstance | undefined;
  let myId: string | undefined;

  try {
    await stage('signed out, the guard answers before any router, the webhook and ingress check answer before the guard, and metrics want their token', async () => {
      const anonymous = client();
      const guarded = await anonymous.get('/api/projects');
      assert.equal(guarded.status, 401, `signed out, /api/projects answered ${guarded.status}`);
      const webhook = await anonymous.post('/webhooks/gitea/no-such-project', JSON.stringify({ ref: 'refs/heads/main', after: 'abc' }), { headers: { 'Content-Type': 'application/json' } });
      assert.equal(webhook.status, 404, `the webhook answered ${webhook.status}: ${JSON.stringify(webhook.data)}`);
      assert.equal(webhook.data?.error, 'Unknown project');
      const ingress = await anonymous.get('/ingress/verify');
      assert.equal(ingress.status, 400, `/ingress/verify answered ${ingress.status}`);
      const metrics = await anonymous.get('/api/metrics');
      assert.equal(metrics.status, 401, `/api/metrics answered ${metrics.status}`);
      const keys = await anonymous.get('/.well-known/temporal-jwks.json');
      assert.equal(keys.status, 200, `Temporal's public key answered ${keys.status}`);
      assert.deepEqual(Object.keys((keys.data as { keys: Record<string, unknown>[] }).keys[0] ?? {}).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
    });

    await stage('a browser\'s CSP reports are taken, and an address sending endless ones is turned away', async () => {
      const anonymous = client();
      const report = JSON.stringify({ 'csp-report': { 'document-uri': 'http://localhost/', 'violated-directive': 'script-src', 'blocked-uri': 'inline' } });
      let answered = 0;
      for (let sent = 0; sent < 200; sent += 1) {
        answered = (await anonymous.post('/csp-report', report, { headers: { 'Content-Type': 'application/csp-report' } })).status;
        if (answered === 429) break;
      }
      assert.equal(answered, 429, 'two hundred CSP reports from one address were all taken');
    });

    await stage('a throwaway account signs up with an admin\'s invite', async () => {
      const invite = (await adminHttp.post('/api/admin/invites')).data as { code: string };
      const registered = await signUp(`${ROOT}/api`, { email, password, inviteCode: invite.code });
      assert.equal(registered.status, 200, registered.error);
      const login = await client().post('/api/auth/login', { email, password });
      const cookie = sessionOf(login.headers);
      assert.ok(login.status === 200 && cookie, JSON.stringify(login.data));
      me = client(cookie);
      myId = (await me.get('/api/auth/me')).data.id as string;
    });

    await stage(`every router is mounted: ${SIGNED_IN.length} routes each answer with their own response, none with Express's "Cannot GET"`, async () => {
      const problems: string[] = [];
      for (const probe of SIGNED_IN) {
        const answer = probe.method === 'post' ? await me!.post(probe.path, probe.body) : await me!.get(probe.path);
        if (unmounted(answer)) problems.push(`${probe.method ?? 'get'} ${probe.path}: not mounted`);
        else if (answer.status >= 500) problems.push(`${probe.method ?? 'get'} ${probe.path}: ${answer.status} ${JSON.stringify(answer.data).slice(0, 200)}`);
      }
      assert.deepEqual(problems, []);
    });
  } finally {
    if (me && myId) {
      const removed = await me.delete('/api/account', { data: { confirm: email } });
      if (removed.status === 202) {
        for (let tries = 0; tries < 150 && await db.accounts.getUserById(myId); tries += 1) await sleep(2_000);
        console.log((await db.accounts.getUserById(myId)) ? `    ${email} is still being removed` : '    removed the test account');
      } else {
        console.log(`    could not remove ${email}: ${removed.status} ${JSON.stringify(removed.data)}`);
      }
    }
    await db.close();
  }
  console.log('\nroutes live — PASS');
}

main().catch((err) => {
  console.error(`\nroutes live — FAIL: ${(err as Error).message}`);
  process.exit(1);
});
