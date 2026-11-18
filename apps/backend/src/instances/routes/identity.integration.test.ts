import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER } from '../../platform/routes/test-harness.js';
import { identityRouter } from './identity.js';
import { IdentityService } from '../services/IdentityService.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem } from '../lib/identity-token.js';

const signing = identityKeysFrom(generateIdentityKey());
const quiet = { validateStatus: () => true, maxRedirects: 0 };

describe('root\'s identity routes', () => {
  it('publishes its public key, tells a signed-in owner their instance has not named its sign-in key, and once it has sends them to its own sign-in', async () => {
    let identity: IdentityService | undefined;
    const h = await mountRouter({
      prefix: '/api/identity',
      router: (db) => {
        identity = new IdentityService({ role: 'root', signing }, db);
        return identityRouter({ servesTenants: false, accounts: { identity, signedIn: async (req) => (req.headers.cookie?.includes('session=ok') ? TEST_USER : undefined), reachOf: async (instanceId) => (await db.instances.getWatch(instanceId))?.reach } });
      },
    });

    const keys = await axios.get<{ keys: unknown }>(h.url('/api/identity/keys'));
    expect(keys.data.keys).toEqual([{ kid: signing.kid, publicKey: publicKeyPem(signing.publicKey) }]);

    const signedOut = await axios.get(h.url('/api/identity/go'), quiet);
    expect([signedOut.status, signedOut.headers.location]).toEqual([302, '/']);
    const signedIn = { ...quiet, headers: { Cookie: 'session=ok' } };
    expect((await axios.get(h.url('/api/identity/go'), signedIn)).status).toBe(404);
    await identity!.register({ id: 'inst-test', ownerId: TEST_USER.id, url: 'https://test.example.com' });

    expect((await axios.get(h.url('/api/identity/instance'))).data).toEqual({ instance: { id: 'inst-test', url: 'https://test.example.com', signInWaiting: 'your Koala has not named its sign-in key to root yet; it does so as it starts' }, servesTenants: false });
    const waiting = await axios.get(h.url('/api/identity/go'), signedIn);
    expect([waiting.status, waiting.data, waiting.headers.location]).toEqual([409, { error: 'your Koala has not named its sign-in key to root yet; it does so as it starts' }, undefined]);

    await h.db.instances.saveSignInKey('inst-test', { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'x', kid: 'k' }, since: '2026-10-29T00:00:00.000Z' });
    expect((await axios.get(h.url('/api/identity/instance'))).data).toEqual({ instance: { id: 'inst-test', url: 'https://test.example.com' }, servesTenants: false });
    await h.db.instances.saveReach({ id: 'inst-test', ownerId: TEST_USER.id }, { reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z' });
    expect((await axios.get<{ instance: unknown }>(h.url('/api/identity/instance'))).data.instance).toEqual({ id: 'inst-test', url: 'https://test.example.com' });
    await h.db.instances.saveReach({ id: 'inst-test', ownerId: TEST_USER.id }, { reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z', toldDown: true });
    expect((await axios.get<{ instance: unknown }>(h.url('/api/identity/instance'))).data.instance).toEqual({ id: 'inst-test', url: 'https://test.example.com', unreachableSince: '2026-10-29T10:00:00.000Z' });
    const go = await axios.get(h.url('/api/identity/go'), signedIn);
    expect([go.status, go.headers.location]).toEqual([302, 'https://test.example.com/api/auth/oidc/start']);
    expect(go.headers['cache-control']).toBe('no-store');
    await h.close();
  });
});

describe('an instance\'s identity route', () => {
  it('answers where a signed-in person is: here, serving tenants', async () => {
    const h = await mountRouter({ prefix: '/api/identity', router: () => identityRouter({ servesTenants: true }) });
    expect((await axios.get(h.url('/api/identity/instance'))).data).toEqual({ instance: null, servesTenants: true });
  });
});
