import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import { bootstrap } from './index.js';
import axios from 'axios';
import http from 'http';

describe('Auth Endpoints & Route Protection Integration', () => {
  let app: express.Application;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    // Bootstrap backend
    const res = await bootstrap();
    app = res.app;

    // Start a temporary test server on a random free port
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        port = addr.port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  const getUrl = (path: string) => `http://127.0.0.1:${port}${path}`;

  it('should block protected routes with 401 when no session is provided', async () => {
    try {
      await axios.get(getUrl('/api/clusters'));
      expect.fail('Should have failed with 401');
    } catch (err: any) {
      expect(err.response.status).toBe(401);
      expect(err.response.data.error).toContain('Session missing');
    }
  });

  it('should register and log in natively, returning correct JWT session cookie', async () => {
    const email = `test-user-${Date.now()}@example.com`;
    const password = 'myPassword123';

    // Register
    const regRes = await axios.post(getUrl('/api/auth/register'), { email, password });
    expect(regRes.status).toBe(200);
    expect(regRes.data.success).toBe(true);

    // Login
    const loginRes = await axios.post(getUrl('/api/auth/login'), { email, password });
    expect(loginRes.status).toBe(200);
    expect(loginRes.data.success).toBe(true);
    expect(loginRes.headers['set-cookie']).toBeDefined();
    
    const sessionCookie = loginRes.headers['set-cookie']![0]!.split(';')[0]!;
    expect(sessionCookie).toContain('session=');

    // Access profile using the cookie
    const profileRes = await axios.get(getUrl('/api/auth/me'), {
      headers: { Cookie: sessionCookie },
    });
    expect(profileRes.status).toBe(200);
    expect(profileRes.data.email).toBe(email);
    expect(profileRes.data.twoFactorEnabled).toBe(false);

    // Now protected routes should succeed
    const clustersRes = await axios.get(getUrl('/api/clusters'), {
      headers: { Cookie: sessionCookie },
    });
    expect(clustersRes.status).toBe(200);
  });

  it('should support Mock social oauth redirect loops', async () => {
    // GitHub redirect
    const ghRes = await axios.get(getUrl('/api/auth/github'), { maxRedirects: 0, validateStatus: () => true });
    expect(ghRes.status).toBe(302);
    expect(ghRes.headers.location).toContain('/api/auth/github/callback?code=mock-github-code');

    // Google redirect
    const gRes = await axios.get(getUrl('/api/auth/google'), { maxRedirects: 0, validateStatus: () => true });
    expect(gRes.status).toBe(302);
    expect(gRes.headers.location).toContain('/api/auth/google/callback?code=mock-google-code');
  });
});
