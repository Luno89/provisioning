import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { credentialsRouter } from './credentials.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { CLOUD_PROVIDERS } from '../lib/types.js';

/**
 * The first HTTP-level tests of a route in this codebase.
 *
 * 145 of the 150 routes in index.ts have none, because until routers existed the only way to reach
 * one was to boot the whole application. These drive the real Express stack — routing, params,
 * middleware, JSON — against a stubbed service, so what is under test is the ROUTE: its status
 * codes, its validation, and what it passes to the service.
 *
 * The service itself is stubbed rather than real. `CredentialService` encrypts with AES-256-GCM and
 * talks to live provider APIs to validate; it has its own tests. What was never covered is the
 * layer between HTTP and that service, which is exactly where the duplicated provider check and the
 * eight hand-written 500s lived.
 */

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
    // Scoped to the caller, never to a parameter — the rule every route here follows.
    expect(svc.getConfiguredProviders).toHaveBeenCalledWith(TEST_USER.id);
  });

  it('refuses an unauthenticated caller', async () => {
    const { h } = await mount(service(), null);
    await expect(axios.get(h.url('/api/credentials'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});

/**
 * ── THE CHECK THAT WAS WRITTEN FOUR TIMES ──
 *
 * `VALID_PROVIDERS.includes(provider)` appeared in four handlers, validating against an array that
 * duplicated the `CloudProvider` union by hand. It is one middleware now, and this iterates the
 * route table rather than naming routes, so a fifth `:provider` route added without it fails here.
 */
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
    // Guards the other direction: a provider added to CLOUD_PROVIDERS but unreachable through the
    // API is just as broken, and far quieter.
    const { h } = await mount();
    for (const provider of CLOUD_PROVIDERS) {
      const res = await axios.get(h.url(`/api/credentials/${provider}`));
      expect(res.status, provider).toBe(200);
      expect(res.data.provider, provider).toBe(provider);
    }
  });

  it('does not mistake the googledrive OAuth paths for a provider id', async () => {
    // `/:provider` is registered before `/googledrive/connect`. They differ in segment count so
    // they do not collide — but that is a fact about Express's matching, not an obvious one, and
    // reordering the router must not silently turn the connect link into a credentials lookup.
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
    // The read-back is what masks the secret. Echoing the body would hand the plaintext straight
    // back to the browser that just sent it.
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
    // Its refresh token arrives from the OAuth callback and is never typed into the form, so
    // validating `req.body` would always test an empty object and always report failure.
    const { h, svc } = await mount();
    await axios.post(h.url('/api/credentials/validate/googledrive'), {});
    expect(svc.testGoogleDriveConnection).toHaveBeenCalledWith(TEST_USER.id);
    expect(svc.validateCredentials).not.toHaveBeenCalled();
  });

  it('checks the submitted values for every other provider', async () => {
    // The opposite case, and the reason googledrive is special-cased rather than the rule: these
    // are validated BEFORE being saved, so the stored ones are the wrong thing to look at.
    const { h, svc } = await mount();
    await axios.post(h.url('/api/credentials/validate/aws'), { accessKeyId: 'k' });
    expect(svc.validateCredentials).toHaveBeenCalledWith('aws', { accessKeyId: 'k' });
    expect(svc.testGoogleDriveConnection).not.toHaveBeenCalled();
  });
});

describe('when the service throws', () => {
  it('answers 500 with a readable body instead of hanging', async () => {
    /**
     * The reason `asyncRoute` exists. Express 4 does not await handlers, so a rejected promise
     * produces an unhandled rejection and NO response — the client waits until it times out. The
     * previous defence was eight hand-written try/catch blocks, and it only takes one omission.
     */
    const svc = service();
    svc.getConfiguredProviders.mockRejectedValueOnce(new Error('vault unreachable') as never);
    const { h } = await mount(svc);
    await expect(axios.get(h.url('/api/credentials'), { timeout: 3000 })).rejects.toMatchObject({
      response: { status: 500, data: { error: 'vault unreachable' } },
    });
  });
});
