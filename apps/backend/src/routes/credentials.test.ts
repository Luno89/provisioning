import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { credentialsRouter } from './credentials.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { CLOUD_PROVIDERS } from '../lib/types.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const service = () => ({
  getConfiguredProviders: vi.fn(async () => [{ provider: 'aws', configured: true }]),
  getCredentials: vi.fn(async () => ({ accessKeyId: 'AKIA••••' })),
  saveCredentials: vi.fn(async () => undefined),
  deleteCredentials: vi.fn(async () => undefined),
  validateCredentials: vi.fn(async () => ({ valid: true })),
  testGoogleDriveConnection: vi.fn(async () => ({ valid: true, message: 'ok' })),
});

const mount = async (svc = service(), user: typeof TEST_USER | null = TEST_USER) => {
  h = await mountRouter({
    prefix: '/api/credentials',
    user,
    router: () => credentialsRouter({
      credentialService: svc as never,
      publicUrl: 'https://api.example.com',
      appUrl: 'https://app.example.com',
    }),
  });
  return { h: h!, svc };
};

describe('listing configured providers', () => {
  it('returns them under `providers`, which is the shape the UI reads', async () => {
    const { h, svc } = await mount();
    const res = await axios.get(h.url('/api/credentials'));
    expect(res.status).toBe(200);
    expect(res.data.providers).toEqual([{ provider: 'aws', configured: true }]);
    expect(svc.getConfiguredProviders).toHaveBeenCalledWith(TEST_USER.id);
  });

  it('refuses an unauthenticated caller', async () => {
    const { h } = await mount(service(), null);
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
      const res = await axios.get(h.url(`/api/credentials/${provider}`));
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
});

describe('reading and writing one provider', () => {
  it('saves, then reads back rather than echoing the request', async () => {
    const { h, svc } = await mount();
    const res = await axios.put(h.url('/api/credentials/aws'), { accessKeyId: 'AKIAREAL', secret: 's' });
    expect(res.status).toBe(200);
    expect(svc.saveCredentials).toHaveBeenCalledWith(TEST_USER.id, 'aws', { accessKeyId: 'AKIAREAL', secret: 's' });
    expect(res.data.credentials).toEqual({ accessKeyId: 'AKIA••••' });
    expect(JSON.stringify(res.data)).not.toContain('AKIAREAL');
  });

  it('deletes for the calling user only', async () => {
    const { h, svc } = await mount();
    const res = await axios.delete(h.url('/api/credentials/hetzner'));
    expect(res.data).toEqual({ success: true, provider: 'hetzner' });
    expect(svc.deleteCredentials).toHaveBeenCalledWith(TEST_USER.id, 'hetzner');
  });

  it('never lets one tenant read another', async () => {
    const { h, svc } = await mount();
    h.setUser({ id: 'someone-else', email: 'other@example.com', isAdmin: false });
    await axios.get(h.url('/api/credentials/aws'));
    expect(svc.getCredentials).toHaveBeenCalledWith('someone-else', 'aws');
  });
});

describe('validating credentials', () => {
  it('checks the STORED token for googledrive, not the request body', async () => {
    const { h, svc } = await mount();
    await axios.post(h.url('/api/credentials/validate/googledrive'), {});
    expect(svc.testGoogleDriveConnection).toHaveBeenCalledWith(TEST_USER.id);
    expect(svc.validateCredentials).not.toHaveBeenCalled();
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
    const svc = service();
    svc.getConfiguredProviders.mockRejectedValueOnce(new Error('vault unreachable') as never);
    const { h } = await mount(svc);
    await expect(axios.get(h.url('/api/credentials'), { timeout: 3000 })).rejects.toMatchObject({
      response: { status: 500, data: { error: 'vault unreachable' } },
    });
  });
});
