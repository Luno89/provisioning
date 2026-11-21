import { testIdentityKey, testKeyEnv } from './platform/testing/keys.js';
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { testMinioEnv } from './files/testing/real-minio.js';
import { NO_SERVICE_HOST, TEST_RELEASE, unreachedPlatformServices } from './platform/testing/platform-services.js';
import express from 'express';
import axios from 'axios';
import http from 'http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'net';

describe('Auth Endpoints & Route Protection Integration', () => {
  let app: express.Application;
  let server: http.Server;
  let port: number;
  let session = '';
  const SETUP_CODE = 'routes-test-setup-code';
  const from = process.cwd();
  const homeWas = process.env.HOME;
  let home = '';

  beforeAll(async () => {
    axios.defaults.proxy = false;
    process.env.ROLE = 'root';
    process.env.ADMIN_SETUP_CODE = SETUP_CODE;
    process.env.IS_E2E = 'true';
    Object.assign(process.env, testMinioEnv(), unreachedPlatformServices(), testKeyEnv('routes'), { ROOT_IDENTITY_KEY: testIdentityKey() }, {
      PORT: '0', PUBLIC_URL: 'http://127.0.0.1:3001', APP_URL: 'http://127.0.0.1:3001', TERRAFORM_STATE: 'local',
      TEMPORAL_CONNECTION_ADDRESS: NO_SERVICE_HOST, TEMPORAL_NAMESPACE: 'default', TEMPORAL_TLS_CA: inject('temporalCa'),
      INSTANCE_IMAGE_TAG: TEST_RELEASE.imageTag, INSTANCE_REGISTRY: TEST_RELEASE.registry,
    });
    home = await mkdtemp(join(tmpdir(), 'koala-routes-'));
    process.env.DATA_DIR = join(home, 'data');
    process.chdir(home);
    process.env.HOME = home;
    const { bootstrap } = await import('./index.js');
    const res = await bootstrap();
    app = res.app;

    // Setup seeds the catalogues; the server no longer does it on start. This is the same call
    // scripts/setup.sh makes, against the database the server actually opened.
    const { seedAll } = await import('./scripts/seed-all.js');
    await seedAll(res.db);

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    delete process.env.IS_E2E;
    if (server) {
      server.close();
    }
    process.chdir(from);
    process.env.HOME = homeWas;
    await rm(home, { recursive: true, force: true });
  });

  const getUrl = (path: string) => `http://127.0.0.1:${port}${path}`;

  it('a request without a session is refused whatever the environment says', async () => {
    const res = await axios.get<{ error: string }>(getUrl('/api/auth/me'), { validateStatus: () => true });
    expect(res.status).toBe(401);
  });

  it('should block protected routes with 401 when no session is provided', async () => {
    const res = await axios.get<{ error: string }>(getUrl('/api/clusters'), { validateStatus: () => true });
    expect(res.status).toBe(401);
    expect(res.data.error).toContain('Session missing');
  });

  it('answers a request it refuses with its reason as JSON, never Express\'s own error page', async () => {
    const res = await axios.post(getUrl('/api/auth/login'), '{"email": "a@example.com", ', { headers: { 'content-type': 'application/json' }, validateStatus: () => true });
    expect(res.status).toBe(400);
    expect(String(res.headers['content-type'])).toMatch(/^application\/json/);
    expect((res.data as { error?: string }).error).toMatch(/JSON/);
  });

  it('should register and log in natively, returning correct JWT session cookie', async () => {
    const email = `test-user-${Date.now()}@example.com`;
    const password = 'a-koala-routes-password';

    const regRes = await axios.post<{ success: boolean }>(getUrl('/api/auth/register'), { email, password, inviteCode: SETUP_CODE });
    expect(regRes.status).toBe(200);
    expect(regRes.data.success).toBe(true);

    const loginRes = await axios.post<{ success: boolean }>(getUrl('/api/auth/login'), { email, password });
    expect(loginRes.status).toBe(200);
    expect(loginRes.data.success).toBe(true);
    expect(loginRes.headers['set-cookie']).toBeDefined();
    
    const sessionCookie = loginRes.headers['set-cookie']!.map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?koala_sid=./.test(pair)) ?? '';
    session = sessionCookie;
    expect(sessionCookie).toMatch(/^(__Host-)?koala_sid=s%3A/);

    const profileRes = await axios.get<{ email: string; twoFactorEnabled: boolean }>(getUrl('/api/auth/me'), {
      headers: { Cookie: sessionCookie },
    });
    expect(profileRes.status).toBe(200);
    expect(profileRes.data.email).toBe(email);
    expect(profileRes.data.twoFactorEnabled).toBe(false);

    const invitesRes = await axios.get(getUrl('/api/admin/invites'), {
      headers: { Cookie: sessionCookie },
    });
    expect(invitesRes.status).toBe(200);
  });

  it('a signed-in request from another origin gets no CORS allowance, outside production too', async () => {
    expect(session).toBeTruthy();
    const foreign = await axios.get(getUrl('/api/auth/me'), { headers: { Cookie: session, Origin: 'http://elsewhere.localhost:5173' }, validateStatus: () => true });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    expect(foreign.headers['access-control-allow-credentials']).toBeUndefined();
    const ours = await axios.get(getUrl('/api/auth/me'), { headers: { Cookie: session, Origin: 'http://127.0.0.1:3001' }, validateStatus: () => true });
    expect(ours.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3001');
  });

  it('no longer starts work the old way: no hand-made leaves, branch chats or legacy chat turns', async () => {
    expect(session).toBeTruthy();
    const auth = { headers: { Cookie: session }, validateStatus: () => true };

    for (const [path, body] of [['/api/leaves', { title: 'by hand' }], ['/api/branches', { title: 'a chat' }], ['/api/chat', { message: 'hi' }], ['/api/chat-pack/koala', { message: 'hi' }]] as const) {
      const res = await axios.post(getUrl(path), body, auth);
      expect(res.status, path).toBe(404);
    }
  });

  it('serves no install.sh join: its scripts, its join commands and the join they made answer 404', async () => {
    expect(session).toBeTruthy();
    for (const path of ['/install.sh', '/install/setup-gpu.sh']) {
      expect((await axios.get(getUrl(path), { validateStatus: () => true })).status, path).toBe(404);
    }
    for (const path of ['/api/instances/join-tokens', '/api/instances/join', '/api/instances/join?format=env']) {
      expect((await axios.post(getUrl(path), { name: 'luno', token: 'a-join-token' }, { headers: { Cookie: session }, validateStatus: () => true })).status, path).toBe(404);
    }
  });

  it('offers exactly the sign-in providers this server is configured for, and no pretend one', async () => {
    const { signInProvidersFrom } = await import('./accounts/index.js');
    const offered = await axios.get<{ providers: unknown }>(getUrl('/api/auth/sign-in'), { validateStatus: () => true });
    expect(offered.status).toBe(200);
    expect(offered.data.providers).toEqual(signInProvidersFrom(process.env).providers.map(({ id, label }) => ({ id, label })));
    expect((await axios.get(getUrl('/api/auth/provider/nobody'), { maxRedirects: 0, validateStatus: () => true })).status).toBe(404);
    for (const old of ['/api/auth/google', '/api/auth/github/callback?code=mock-github-code']) {
      expect((await axios.get(getUrl(old), { maxRedirects: 0, validateStatus: () => true })).status, old).toBe(401);
    }
  });
});
