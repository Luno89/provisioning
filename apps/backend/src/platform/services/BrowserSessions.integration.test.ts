import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localCommands, removeSteps, runSteps } from '@koala/provision';
import { memoryReporter, type ContainerContext } from '@koala/provision/testing';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { instanceRouteFiles } from '../../instances/lib/instance-routes.js';
import { ROOT_TRUST_PROXY, trustProxyFrom, type TrustProxy } from '../lib/client-address.js';
import type { PlatformRole } from '../lib/platform-role.js';
import { memoryDatabase } from '../testing/memory-database.js';
import { rootCaddy, type RootCaddy } from '../testing/edge-caddy.js';
import { browserSessionsFor } from './BrowserSessions.js';

const REPO = resolve(import.meta.dirname, '../../../../..');
const ROOT_UPSTREAM = 'reverse_proxy 127.0.0.1:3001 {';
const MESH_IP = '100.64.0.7';
const APP_DOMAIN = 'koala.localhost';
const INGRESS_DOMAIN = 'apps.localhost';
const INSTANCE_HOST = `luno.${INGRESS_DOMAIN}`;
const SPOOFED = '203.0.113.9';

const ctx: ContainerContext = { commands: localCommands(process.env) };
const servers: Server[] = [];
let caddy: RootCaddy | undefined;
let rootCa = '';

const LOOPBACK = '127.0.0.1';

function trustOf(role: PlatformRole): TrustProxy {
  if (role === 'root') return ROOT_TRUST_PROXY;
  const written = /^\s+TRUST_PROXY: "([^"]+)"$/m.exec(readFileSync(join(REPO, 'charts/instance/templates/configmap-env.yaml'), 'utf8'));
  const trust = trustProxyFrom(written?.[1]);
  if (!('trust' in trust)) throw new Error(trust.problem);
  return trust.trust;
}

async function backendOf(role: PlatformRole, publicUrl: string): Promise<number> {
  const app = express();
  app.set('trust proxy', trustOf(role));
  const sessions = browserSessionsFor(role, publicUrl, { store: memoryDatabase().platform, secret: `behind-caddy-${role}` });
  app.use(sessions.handle);
  app.post('/hold', (req, res, next) => {
    sessions.hold(req, { sub: 'ann', email: 'ann@example.com', claims: [{ role: 'person' }], sessionAt: 1, accessExp: 2, rootSid: 'r', tokens: { access: 'a', refresh: 'r', id: 'i' } })
      .then(() => res.json({ ip: req.ip, secure: req.secure }), next);
  });
  app.get('/me', (req, res) => { res.json({ sub: req.session.person?.sub ?? null }); });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, LOOPBACK, done));
  return (server.address() as AddressInfo).port;
}

function throughCaddy(host: string, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; set: string[]; body: Record<string, unknown> }> {
  return new Promise((done, failed) => {
    const asked = request({ host: LOOPBACK, port: caddy!.https, servername: host, ca: rootCa, method, path, headers: { host, ...headers } }, (answer) => {
      let body = '';
      answer.setEncoding('utf8');
      answer.on('data', (chunk: string) => { body += chunk; });
      answer.on('end', () => done({ status: answer.statusCode ?? 0, set: answer.headers['set-cookie'] ?? [], body: JSON.parse(body) as Record<string, unknown> }));
    });
    asked.on('error', failed);
    asked.end();
  });
}

beforeAll(async () => {
  const rootPort = await backendOf('root', `https://${APP_DOMAIN}`);
  const instancePort = await backendOf('instance', `https://${INSTANCE_HOST}`);
  const caddyfile = readFileSync(join(REPO, 'Caddyfile'), 'utf8');
  if (!caddyfile.includes(ROOT_UPSTREAM)) throw new Error(`root's Caddyfile no longer proxies the app with "${ROOT_UPSTREAM}"`);
  const instanceHandles = instanceRouteFiles({ name: 'luno', meshIp: MESH_IP, nested: false }, INGRESS_DOMAIN).handles;
  const folder = mkdtempSync(join(tmpdir(), 'koala-root-caddy-'));
  for (const sub of ['tls', 'apps', 'instances', 'instance-sites', 'admin', 'log']) {
    mkdirSync(join(folder, sub));
    chmodSync(join(folder, sub), 0o777);
  }
  chmodSync(folder, 0o755);
  writeFileSync(join(folder, 'tls', 'koala.caddy'), 'tls internal\n');
  writeFileSync(join(folder, 'instances', 'luno.caddy'), instanceHandles.replace(`${MESH_IP}:30320`, `${LOOPBACK}:${instancePort}`));
  caddy = rootCaddy(caddyfile.replace(ROOT_UPSTREAM, `reverse_proxy ${LOOPBACK}:${rootPort} {`), folder, { APP_DOMAIN, MESH_DOMAIN: 'mesh.localhost', INGRESS_DOMAIN, ACME_EMAIL: 'admin@example.com' },
    { https: await portToHandOn(), http: await portToHandOn(), metrics: await portToHandOn() });
  await runSteps([caddy.step], ctx, memoryReporter());
  rootCa = await caddy.rootCertificate();
  await caddy.certificatesHeldFor([APP_DOMAIN, INSTANCE_HOST]);
});

afterAll(async () => {
  if (caddy) await removeSteps([caddy.step], ctx, memoryReporter());
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
}, 0);

describe.each([
  { who: 'root', host: APP_DOMAIN },
  { who: 'an instance, through root\'s route to it', host: INSTANCE_HOST },
])('a browser signing in on $who behind root\'s real Caddy', ({ host }) => {
  it('is given the __Host- session cookie over https and stays signed in with it, whatever forwarding headers the browser itself sends', async () => {
    const signedIn = await throughCaddy(host, 'POST', '/hold', { 'x-forwarded-for': SPOOFED, 'x-forwarded-proto': 'http' });
    expect(signedIn.status).toBe(200);
    expect(signedIn.set).toHaveLength(1);
    expect(signedIn.set[0]).toMatch(/^__Host-koala_sid=s%3A[^;]+; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$/);
    expect(signedIn.body.secure).toBe(true);
    expect(signedIn.body.ip).not.toBe(SPOOFED);
    expect(signedIn.body.ip).toBe(LOOPBACK);
    const cookie = signedIn.set[0]!.split(';')[0]!;
    expect((await throughCaddy(host, 'GET', '/me', { cookie })).body).toEqual({ sub: 'ann' });
  });
});
