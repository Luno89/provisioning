import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { credentialsRouter } from './credentials.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { CLOUD_PROVIDERS } from '../../platform/lib/types.js';
import { CredentialService } from '../services/CredentialService.js';

const KEY = 'test-data-key';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const spied = (service: CredentialService) => ({
  service,
  getConfiguredProviders: vi.spyOn(service, 'getConfiguredProviders'),
  getCredentials: vi.spyOn(service, 'getCredentials'),
  saveCredentials: vi.spyOn(service, 'saveCredentials'),
  deleteCredentials: vi.spyOn(service, 'deleteCredentials'),
  validateCredentials: vi.spyOn(service, 'validateCredentials'),
  testGoogleDriveConnection: vi.spyOn(service, 'testGoogleDriveConnection'),
});

type Spied = ReturnType<typeof spied>;

const mount = async (user: typeof TEST_USER | null = TEST_USER) => {
  let svc: Spied | undefined;
  h = await mountRouter({
    prefix: '/api/credentials',
    user,
    router: async (db) => {
      await db.accounts.saveUser({ id: TEST_USER.id, email: TEST_USER.email, twoFactorEnabled: false, emailVerified: true, createdAt: 'then' } as never);
      const service = new CredentialService(db, KEY);
      await service.saveCredentials(TEST_USER.id, 'aws', { accessKeyId: 'AKIASTOREDKEY0001', secretAccessKey: 'stored-secret-0001' });
      await service.saveCredentials(TEST_USER.id, 'hetzner', { token: 'hetzner-token-0001' });
      svc = spied(service);
      return credentialsRouter({
        credentialService: service,
        publicUrl: 'https://api.example.com',
        appUrl: 'https://app.example.com',
        sessionKey: 'test-session-key',
      });
    },
  });
  return { h: h!, svc: svc!, db: h!.db };
};

describe('listing configured providers', () => {
  it('returns them under `providers`, which is the shape the UI reads', async () => {
    const { h, svc } = await mount();
    const res = await axios.get<{ providers: { provider: string; configured: boolean }[] }>(h.url('/api/credentials'));
    expect(res.status).toBe(200);
    expect(res.data.providers.filter((provider) => provider.configured)).toEqual([
      { provider: 'aws', label: 'Amazon Web Services', configured: true, source: 'user', summary: { AWS_ACCESS_KEY_ID: 'AKIA****0001', AWS_SECRET_ACCESS_KEY: 'stor****0001' }, clusters: 'mock-only' },
      { provider: 'hetzner', label: 'Hetzner Cloud', configured: true, source: 'user', summary: { HCLOUD_TOKEN: 'hetz****0001' }, clusters: 'available' },
    ]);
    expect(svc.getConfiguredProviders).toHaveBeenCalledWith(TEST_USER.id);
  });

  it('refuses an unauthenticated caller', async () => {
    const { h } = await mount(null);
    await expect(axios.get(h.url('/api/credentials'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});

describe('provider validation', () => {
  const guarded: [string, (url: string) => Promise<unknown>][] = [
    ['GET /:provider', (u) => axios.get(u)],
    ['PUT /:provider', (u) => axios.put(u, {})],
    ['DELETE /:provider', (u) => axios.delete(u)],
    ['POST /validate/:provider', (u) => axios.post(u, {})],
  ];

  for (const [label, call] of guarded) {
    it(`rejects an unknown provider on ${label}`, async () => {
      const { h } = await mount();
      const path = label.includes('validate')
        ? '/api/credentials/validate/not-a-cloud'
        : '/api/credentials/not-a-cloud';
      await expect(call(h.url(path))).rejects.toMatchObject({
        response: { status: 400, data: { error: 'Invalid provider: not-a-cloud' } },
      });
    });
  }

  it('accepts every provider the platform actually supports', async () => {
    const { h } = await mount();
    for (const provider of CLOUD_PROVIDERS) {
      const res = await axios.get<{ provider: string }>(h.url(`/api/credentials/${provider}`));
      expect(res.status, provider).toBe(200);
      expect(res.data.provider, provider).toBe(provider);
    }
  });

  it('does not mistake the googledrive OAuth paths for a provider id', async () => {
    const { h } = await mount();
    const res = await axios.get(h.url('/api/credentials/googledrive/connect'), {
      maxRedirects: 0,
      validateStatus: () => true,
    });
    expect(res.status).toBe(302);
  });

  it('connects Google Drive only to the person who started connecting it', async () => {
    const was = process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_ID = 'drive-client';
    try {
      const { h, svc } = await mount();
      const started = await axios.get(h.url('/api/credentials/googledrive/connect'), { maxRedirects: 0, validateStatus: () => true });
      const state = new URL(String(started.headers.location)).searchParams.get('state');
      expect(state).toMatch(/^[\w-]{32}$/);
      expect(String(started.headers['set-cookie'])).toContain('oauth_state=');
      const forged = await axios.get(h.url(`/api/credentials/googledrive/callback?code=theirs&state=${state}`), { maxRedirects: 0, validateStatus: () => true });
      expect(forged.headers.location).toBe('https://app.example.com/?driveError=not_started_here#/settings');
      expect(svc.saveCredentials).not.toHaveBeenCalled();
    } finally {
      if (was === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = was;
    }
  });
});

describe('reading and writing one provider', () => {
  it('saves, then reads back rather than echoing the request', async () => {
    const { h, svc } = await mount();
    const res = await axios.put<{ credentials: unknown }>(h.url('/api/credentials/aws'), { accessKeyId: 'AKIAREALKEY00042', secret: 's' });
    expect(res.status).toBe(200);
    expect(svc.saveCredentials).toHaveBeenCalledWith(TEST_USER.id, 'aws', { accessKeyId: 'AKIAREALKEY00042', secret: 's' });
    expect(res.data.credentials).toEqual({ accessKeyId: 'AKIA****0042', secretAccessKey: 'stor****0001' });
    expect(JSON.stringify(res.data)).not.toContain('AKIAREALKEY00042');
  });

  it('deletes for the calling user only', async () => {
    const { h, svc, db } = await mount();
    const res = await axios.delete(h.url('/api/credentials/hetzner'));
    expect(res.data).toEqual({ success: true, provider: 'hetzner' });
    expect(svc.deleteCredentials).toHaveBeenCalledWith(TEST_USER.id, 'hetzner');
    expect(Object.keys((await db.accounts.getUserById(TEST_USER.id))?.credentials ?? {})).toEqual(['aws']);
  });

  it('never lets one tenant read another', async () => {
    const { h, svc } = await mount();
    h.setUser({ id: 'someone-else', email: 'other@example.com' });
    const res = await axios.get<{ credentials: unknown }>(h.url('/api/credentials/aws'));
    expect(svc.getCredentials).toHaveBeenCalledWith('someone-else', 'aws');
    expect(res.data.credentials).toBeNull();
  });
});

describe('validating credentials', () => {
  it('checks the STORED token for googledrive, not the request body', async () => {
    const { h, svc } = await mount();
    await svc.service.saveCredentials(TEST_USER.id, 'googledrive', { refreshToken: 'the-stored-refresh-token' });
    await axios.post(h.url('/api/credentials/validate/googledrive'), { refreshToken: 'one-from-the-request' });
    expect(svc.testGoogleDriveConnection).toHaveBeenCalledWith(TEST_USER.id);
    expect(svc.validateCredentials.mock.calls).toEqual([['googledrive', { refreshToken: 'the-stored-refresh-token' }]]);
  });

  it('checks the submitted values for every other provider', async () => {
    const { h, svc } = await mount();
    await axios.post(h.url('/api/credentials/validate/aws'), { accessKeyId: 'k' });
    expect(svc.validateCredentials).toHaveBeenCalledWith('aws', { accessKeyId: 'k' });
    expect(svc.testGoogleDriveConnection).not.toHaveBeenCalled();
  });
});

describe('when the service throws', () => {
  it('answers 500 with a readable body instead of hanging', async () => {
    const { h, db } = await mount();
    vi.spyOn(db.accounts, 'getUserById').mockRejectedValueOnce(new Error('vault unreachable'));
    await expect(axios.get(h.url('/api/credentials'), { timeout: 3000 })).rejects.toMatchObject({
      response: { status: 500, data: { error: 'vault unreachable' } },
    });
  });
});
