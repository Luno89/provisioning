import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { claimNamespaceFor } from '../workflows/temporal-test-env.js';
import { sessionFrom } from './testing/handoff.js';
import { startRole, type LoopbackRole } from './testing/roles-on-loopback.js';
import { startThreeRoles, type ThreeRoles } from './testing/three-roles.js';

type Role = 'root' | 'instance' | 'hub' | 'combined';
interface Probe { method?: 'post'; path: string; body?: unknown; on: Role[] }

const TENANT: Role[] = ['instance', 'combined'];
const ACCOUNTS: Role[] = ['root', 'combined'];
const EVERY: Role[] = ['root', 'instance', 'hub', 'combined'];

const ROUTERS: Probe[] = [
  { path: '/api/account/removal', on: ACCOUNTS },
  { path: '/api/actions', on: TENANT },
  { path: '/api/admin/invites', on: ACCOUNTS },
  { path: '/api/agents', on: TENANT },
  { path: '/api/app-schemas/odoo', on: TENANT },
  { path: '/api/artifacts/storage', on: TENANT },
  { path: '/api/auth/me', on: EVERY },
  { method: 'post', path: '/api/auth/password/forgot/resend', body: { id: 'no-such-reset' }, on: ACCOUNTS },
  { path: '/api/auto-mode', on: TENANT },
  { path: '/api/binding-types', on: TENANT },
  { path: '/api/branches', on: TENANT },
  { path: '/api/cluster-access', on: TENANT },
  { path: '/api/cluster-providers', on: TENANT },
  { path: '/api/clusters', on: TENANT },
  { path: '/api/conversations', on: TENANT },
  { path: '/api/credentials', on: TENANT },
  { path: '/api/dns-providers', on: TENANT },
  { path: '/api/deployments', on: TENANT },
  { path: '/api/documents/no-such-workspace', on: TENANT },
  { path: '/api/egress/requests', on: TENANT },
  { path: '/api/engine/extensions', on: TENANT },
  { path: '/api/engine-tools', on: TENANT },
  { path: '/api/evals/level2/bench', on: TENANT },
  { path: '/api/files/servers', on: TENANT },
  { path: '/api/hub/projects', on: ['hub', 'combined'] },
  { path: '/api/identity/keys', on: ACCOUNTS },
  { path: '/api/infrastructure', on: TENANT },
  { path: '/api/instance-addresses', on: TENANT },
  { path: '/api/instances/name-check?name=routeslive', on: ACCOUNTS },
  { path: '/api/instance-trial', on: TENANT },
  { method: 'post', path: '/api/items/story/no-such-story/chat', body: {}, on: TENANT },
  { path: '/api/leaves', on: TENANT },
  { path: '/api/logs/cluster/no-such-cluster', on: TENANT },
  { method: 'post', path: '/api/machines/join', body: { code: 'no-such-code' }, on: ACCOUNTS },
  { path: '/api/mcp/servers', on: TENANT },
  { path: '/api/memories', on: TENANT },
  { path: '/api/mesh/local-agents', on: TENANT },
  { path: '/api/models/rate-limits', on: TENANT },
  { path: '/api/modules', on: TENANT },
  { path: '/api/monitoring', on: TENANT },
  { path: '/api/notifications', on: TENANT },
  { path: '/api/pending-approvals', on: TENANT },
  { path: '/api/plans', on: TENANT },
  { path: '/api/procedures', on: TENANT },
  { path: '/api/projects', on: TENANT },
  { path: '/api/project-sharing/no-such-project', on: TENANT },
  { path: '/api/registry/search?q=routes', on: TENANT },
  { path: '/api/release-settings/options', on: TENANT },
  { path: '/api/running', on: TENANT },
  { path: '/api/secret-requests', on: TENANT },
  { path: '/api/server-orders', on: ['combined'] },
  { path: '/api/share/no-such-token', on: TENANT },
  { path: '/api/temporal/status', on: TENANT },
  { path: '/api/trees', on: TENANT },
  { path: '/api/tree-types', on: TENANT },
  { path: '/api/turns', on: TENANT },
  { path: '/api/vps-catalog', on: TENANT },
  { path: '/api/worker', on: TENANT },
  { path: '/api/workspace-dependencies', on: TENANT },
];

interface Answer { status: number; text: string; body: unknown }

async function call(url: string, init: { method?: string; body?: unknown; raw?: string; type?: string; cookie?: string | undefined } = {}): Promise<Answer> {
  const sending = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: { ...(sending !== undefined ? { 'content-type': init.type ?? 'application/json' } : {}), ...(init.cookie ? { Cookie: init.cookie } : {}) },
    ...(sending !== undefined ? { body: sending } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text) as unknown; } catch { body = text; }
  return { status: response.status, text, body };
}

const unmounted = (answer: Answer): boolean => answer.status === 404 && /Cannot (GET|POST)/.test(answer.text);

let roles: ThreeRoles;
let combined: LoopbackRole;
const combinedDatabase = `routes_mounted_${Date.now().toString(36)}_combined`;
const setupCode = randomBytes(12).toString('base64url');
const urls = {} as Record<Role, string>;
const sessions = {} as Record<Role, string>;

beforeAll(async () => {
  roles = await startThreeRoles('routes');
  combined = await startRole('combined', {
    JWT_SECRET: `routes-mounted-${combinedDatabase}`,
    MONGO_URI: `${inject('mongoUri')}${combinedDatabase}`,
    TEMPORAL_CONNECTION_ADDRESS: inject('temporalAddress'),
    TEMPORAL_NAMESPACE: claimNamespaceFor(inject('temporalClaims')),
    CERTIFICATES: 'internal',
    ADMIN_SETUP_CODE: setupCode,
  });
  Object.assign(urls, { root: roles.root.url, instance: roles.instance.url, hub: roles.hub.url, combined: combined.url });
}, 240_000);

afterAll(async () => {
  await combined?.close();
  await roles?.close();
  const client = new MongoClient(inject('mongoUri'));
  await client.connect();
  await client.db(combinedDatabase).dropDatabase();
  await client.close();
});

describe('every router answers where it is mounted, and what is public answers before the guard', () => {
  it('signed out, the guard answers before any router on every role, metrics want their token and Temporal\'s public key is served', async () => {
    for (const role of EVERY) {
      const guarded = await call(`${urls[role]}/api/projects`);
      expect(guarded.status, role).toBe(401);
      expect(await call(`${urls[role]}/api/metrics`).then((answer) => answer.status), role).toBe(401);
      expect((await call(`${urls[role]}/api/auth/sign-in`)).status, role).toBe(200);
      const keys = await call(`${urls[role]}/.well-known/temporal-jwks.json`);
      expect(keys.status, role).toBe(200);
      expect(Object.keys((keys.body as { keys: Record<string, unknown>[] }).keys[0] ?? {}).sort(), role).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
    }
  });

  it('where accounts are held, the sign-in providers are listed signed out and an unknown provider is a 404', async () => {
    for (const role of ACCOUNTS) {
      const providers = await call(`${urls[role]}/api/auth/sign-in`);
      expect(Array.isArray((providers.body as { providers?: unknown }).providers), `${role}: ${providers.text}`).toBe(true);
      expect((await call(`${urls[role]}/api/auth/provider/no-such-provider`)).status, role).toBe(404);
    }
  });

  it('where tenants are served, the Gitea webhook and the ingress check answer before the guard', async () => {
    for (const role of TENANT) {
      const webhook = await call(`${urls[role]}/webhooks/gitea/no-such-project`, { method: 'POST', raw: JSON.stringify({ ref: 'refs/heads/main', after: 'abc' }) });
      expect(webhook.status, `${role}: ${webhook.text}`).toBe(404);
      expect((webhook.body as { error?: string }).error, role).toBe('Unknown project');
      expect((await call(`${urls[role]}/ingress/verify`)).status, role).toBe(400);
    }
  });

  it('a browser\'s CSP reports are taken, and an address sending endless ones is turned away', async () => {
    const report = JSON.stringify({ 'csp-report': { 'document-uri': 'http://localhost/', 'violated-directive': 'script-src', 'blocked-uri': 'inline' } });
    for (const role of EVERY) {
      const first = await call(`${urls[role]}/csp-report`, { method: 'POST', raw: report, type: 'application/csp-report' });
      expect(first.status, role).toBeLessThan(300);
      let answered = first.status;
      for (let sent = 1; sent < 200 && answered !== 429; sent += 1) {
        answered = (await call(`${urls[role]}/csp-report`, { method: 'POST', raw: report, type: 'application/csp-report' })).status;
      }
      expect(answered, `two hundred CSP reports from one address were all taken on ${role}`).toBe(429);
    }
  });

  it('a throwaway account signs up on a combined backend with an admin\'s invite, and the owner is signed in on root, the instance and the hub', async () => {
    const email = `admin-${combinedDatabase.replace(/_/g, '-')}@routes.test`;
    const password = randomBytes(18).toString('base64url');
    expect((await call(`${combined.url}/api/auth/register`, { method: 'POST', body: { email, password, inviteCode: setupCode } })).status).toBe(200);
    const adminLogin = await fetch(`${combined.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const adminCookie = sessionFrom(adminLogin.headers.getSetCookie());
    expect(adminCookie).toBeTruthy();
    const invite = await call(`${combined.url}/api/admin/invites`, { method: 'POST', body: {}, cookie: adminCookie });
    expect(invite.status, invite.text).toBe(201);
    const throwaway = { email: `throwaway-${combinedDatabase.replace(/_/g, '-')}@routes.test`, password: randomBytes(18).toString('base64url') };
    const asked = await call(`${combined.url}/api/auth/register`, { method: 'POST', body: { ...throwaway, inviteCode: (invite.body as { code: string }).code } });
    expect(asked.status, asked.text).toBe(200);
    const { verify, devCode } = asked.body as { verify: string; devCode: string };
    const verified = await fetch(`${combined.url}/api/auth/register/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: verify, code: devCode }) });
    expect(verified.status, await verified.clone().text()).toBe(200);
    const login = await fetch(`${combined.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(throwaway) });
    const cookie = sessionFrom(login.headers.getSetCookie());
    expect(login.status === 200 && cookie, await login.clone().text()).toBeTruthy();
    expect(((await call(`${combined.url}/api/auth/me`, { cookie })).body as { email?: string }).email).toBe(throwaway.email);
    Object.assign(sessions, { combined: cookie, root: roles.owner.cookie, instance: await roles.ownerOnInstance(), hub: await roles.ownerOnHub() });
  });

  it(`every router is mounted where its role serves it: ${ROUTERS.length} routes each answer with their own response, none with Express's "Cannot GET"`, async () => {
    expect(Object.keys(sessions).sort()).toEqual([...EVERY].sort());
    const problems: string[] = [];
    for (const probe of ROUTERS) {
      for (const role of probe.on) {
        const answer = await call(`${urls[role]}${probe.path}`, { method: probe.method === 'post' ? 'POST' : 'GET', body: probe.body, cookie: sessions[role] });
        if (unmounted(answer)) problems.push(`${role}: ${probe.method ?? 'get'} ${probe.path}: not mounted`);
        else if (answer.status >= 500) problems.push(`${role}: ${probe.method ?? 'get'} ${probe.path}: ${answer.status} ${answer.text.slice(0, 200)}`);
      }
    }
    expect(problems).toEqual([]);
    expect(ROUTERS.filter((probe) => !probe.on.includes('combined'))).toEqual([]);
  });
}, 300_000);
