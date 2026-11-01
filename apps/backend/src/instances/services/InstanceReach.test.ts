import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caddyFetch, InstanceReach } from './InstanceReach.js';
import { reachSettingsFrom } from '../lib/instance-reach.js';

let caddy: https.Server;
let port = 0;
let cert: Buffer;
const heard: Array<{ servername: string | undefined; host: string | undefined; path: string | undefined }> = [];

beforeAll(async () => {
  const folder = mkdtempSync(join(tmpdir(), 'own-caddy-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=luno.people.example', '-addext', 'subjectAltName=DNS:*.people.example', '-keyout', join(folder, 'key.pem'), '-out', join(folder, 'cert.pem')], { stdio: 'ignore' });
  cert = readFileSync(join(folder, 'cert.pem'));
  caddy = https.createServer({ key: readFileSync(join(folder, 'key.pem')), cert }, (req, res) => {
    heard.push({ servername: (req.socket as TLSSocket).servername || undefined, host: req.headers.host, path: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"via":"caddy"}');
  });
  await new Promise<void>((resolve) => caddy.listen(0, '127.0.0.1', resolve));
  port = (caddy.address() as AddressInfo).port;
});

afterAll(async () => { await new Promise((resolve) => caddy.close(resolve)); });

describe('root calling one of its people\'s instances', () => {
  it('goes through its own Caddy, naming the instance for TLS and as the host, whatever DNS says', async () => {
    const settings = reachSettingsFrom({ NODE_ENV: 'production', INGRESS_DOMAIN: 'people.example', CADDY_TLS_ADDRESS: `127.0.0.1:${port}` }, false);
    const reach = new InstanceReach(settings, { open: fetch, public: fetch, publicProblem: async () => undefined, viaCaddy: caddyFetch({ ca: cert }) });
    const answer = await reach.fetchFor({ name: 'luno' })('https://luno.people.example/api/auth/oidc/backchannel-logout', { method: 'POST', body: 'logout_token=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(await answer.json()).toEqual({ via: 'caddy' });
    expect(heard.at(-1)).toEqual({ servername: 'luno.people.example', host: 'luno.people.example', path: '/api/auth/oidc/backchannel-logout' });
  });

  it('defaults to the Caddy on this machine\'s port 443, and leaves names outside the people\'s domain alone', () => {
    expect(reachSettingsFrom({ INGRESS_DOMAIN: 'people.example' }, false).ownCaddy).toEqual({ host: '127.0.0.1', port: 443 });
    expect(reachSettingsFrom({}, false).ownCaddy).toBeUndefined();
  });
});
