import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionFrom } from './testing/handoff.js';
import { startThreeRoles, type ThreeRoles } from './testing/three-roles.js';

type Role = 'root' | 'instance' | 'hub';
interface Probe { method?: 'post'; path: string; body?: unknown; on: Role[] }

const TENANT: Role[] = ['instance'];
const ACCOUNTS: Role[] = ['root'];
const EVERY: Role[] = ['root', 'instance', 'hub'];

const ROUTERS: Probe[] = [
  { path: '/api/account/removal', on: ACCOUNTS },
  { path: '/api/actions', on: TENANT },
  { path: '/api/admin/invites', on: ACCOUNTS },
  { path: '/api/agents', on: TENANT },
  { path: '/api/app-schemas/odoo', on: TENANT },
  { path: '/api/artifacts/runs/no-such-run', on: TENANT },
  { path: '/api/auth/me', on: EVERY },
  { method: 'post', path: '/api/auth/password/forgot/resend', body: { id: 'no-such-reset' }, on: ACCOUNTS },
  { path: '/api/auto-mode', on: TENANT },
  { path: '/api/binding-types', on: TENANT },
  { path: '/api/branches', on: TENANT },
  { path: '/api/cluster-access', on: TENANT },
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
  { path: '/api/files/shares', on: TENANT },
  { path: '/api/hub/projects', on: ['hub'] },
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
  { path: '/api/server-orders', on: TENANT },
  { path: '/api/share/no-such-token', on: TENANT },
  { path: '/api/temporal/status', on: TENANT },
  { path: '/api/tool-call-parsers', on: TENANT },
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
const stamp = Date.now().toString(36);
const urls = {} as Record<Role, string>;
const sessions = {} as Record<Role, string>;

beforeAll(async () => {
  roles = await startThreeRoles('routes');
  Object.assign(urls, { root: roles.root.url, instance: roles.instance.url, hub: roles.hub.url });
});

afterAll(async () => {
  await roles?.close();
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

  it('a throwaway account signs up on root with the operator\'s invite, and the owner is signed in on root, the instance and the hub', async () => {
    const invite = await call(`${roles.root.url}/api/admin/invites`, { method: 'POST', body: {}, cookie: roles.operator.cookie });
    expect(invite.status, invite.text).toBe(201);
    const throwaway = await roles.signUp(`throwaway-${stamp}@routes.test`, (invite.body as { code: string }).code);
    const login = await fetch(`${roles.root.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: throwaway.email, password: throwaway.password }) });
    const cookie = sessionFrom(login.headers.getSetCookie());
    expect(login.status === 200 && cookie, await login.clone().text()).toBeTruthy();
    expect(((await call(`${roles.root.url}/api/auth/me`, { cookie })).body as { email?: string }).email).toBe(throwaway.email);
    Object.assign(sessions, { root: roles.owner.cookie, instance: await roles.ownerOnInstance(), hub: await roles.ownerOnHub() });
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
    expect(ROUTERS.filter((probe) => probe.on.length === 0)).toEqual([]);
  });
});
