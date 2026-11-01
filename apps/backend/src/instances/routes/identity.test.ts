import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER } from '../../platform/routes/test-harness.js';
import { identityRouter } from './identity.js';
import { IdentityService } from '../services/IdentityService.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem } from '../lib/identity-token.js';

const signing = identityKeysFrom(generateIdentityKey());
const quiet = { validateStatus: () => true, maxRedirects: 0 };

describe('root\'s identity routes', () => {
  it('publishes its public key, and redirects a signed-in user to their own instance with a token', async () => {
    let identity: IdentityService | undefined;
    const h = await mountRouter({
      prefix: '/api/identity',
      router: (db) => {
        identity = new IdentityService({ role: 'root', signing }, db, undefined, async () => ({ url: '/api/auth/oidc/start' }));
        return identityRouter({ identity, servesTenants: false, signedIn: async (req) => (req.headers.cookie?.includes('session=ok') ? TEST_USER : undefined), reachOf: async (instanceId) => (await db.instances.getWatch(instanceId))?.reach });
      },
    });

    const keys = await axios.get<{ keys: unknown }>(h.url('/api/identity/keys'));
    expect(keys.data.keys).toEqual([{ kid: signing.kid, publicKey: publicKeyPem(signing.publicKey) }]);

    const signedOut = await axios.get(h.url('/api/identity/go'), quiet);
    expect([signedOut.status, signedOut.headers.location]).toEqual([302, '/']);
    const signedIn = { ...quiet, headers: { Cookie: 'session=ok' } };
    expect((await axios.get(h.url('/api/identity/go'), signedIn)).status).toBe(404);
    await identity!.register({ id: 'inst-test', ownerId: TEST_USER.id, url: 'https://test.example.com' });

    expect((await axios.get(h.url('/api/identity/instance'))).data).toEqual({ instance: { id: 'inst-test', url: 'https://test.example.com' }, servesTenants: false });
    await h.db.instances.saveReach({ id: 'inst-test', ownerId: TEST_USER.id }, { reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z' });
    expect((await axios.get<{ instance: unknown }>(h.url('/api/identity/instance'))).data.instance).toEqual({ id: 'inst-test', url: 'https://test.example.com' });
    await h.db.instances.saveReach({ id: 'inst-test', ownerId: TEST_USER.id }, { reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z', toldDown: true });
    expect((await axios.get<{ instance: unknown }>(h.url('/api/identity/instance'))).data.instance).toEqual({ id: 'inst-test', url: 'https://test.example.com', unreachableSince: '2026-10-29T10:00:00.000Z' });
    const go = await axios.get(h.url(`/api/identity/go?nonce=${'n'.repeat(32)}`), signedIn);
    expect(go.status).toBe(302);
    expect(go.headers.location).toMatch(/^https:\/\/test\.example\.com\/#\/handoff\?token=/);
    expect(go.headers['cache-control']).toBe('no-store');

    const instance = (await h.db.instances.getInstances(TEST_USER.id))[0]!;
    await h.db.instances.saveSignInKey(instance.id, { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'x', kid: 'k' }, since: '2026-10-29T00:00:00.000Z' });
    const moved = await axios.get(h.url(`/api/identity/go?nonce=${'n'.repeat(32)}`), signedIn);
    expect([moved.status, moved.headers.location]).toEqual([302, 'https://test.example.com/api/auth/oidc/start']);
    await h.close();
  });
});
