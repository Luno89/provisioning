import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER } from './test-harness.js';
import { identityRouter } from './identity.js';
import { handoffRouter } from './handoff.js';
import { IdentityService } from '../services/IdentityService.js';
import { createAuth } from '../middleware/auth.js';
import { generateIdentityKey, identityKeysFrom, issueHandoff, publicKeyPem, trustedKeys } from '../lib/identity-token.js';
import { verifyJWT } from '../lib/auth.js';

const signing = identityKeysFrom(generateIdentityKey());
const quiet = { validateStatus: () => true, maxRedirects: 0 };

describe('root\'s identity routes', () => {
  it('publishes its public key, and redirects a signed-in user to their own instance with a token', async () => {
    let identity: IdentityService | undefined;
    const h = await mountRouter({
      prefix: '/api/identity',
      router: (db) => {
        identity = new IdentityService({ role: 'root', signing }, db);
        return identityRouter({ identity, servesTenants: false, signedIn: async (req) => (req.headers.cookie?.includes('session=ok') ? TEST_USER : undefined) });
      },
    });

    const keys = await axios.get(h.url('/api/identity/keys'));
    expect(keys.data.keys).toEqual([{ kid: signing.kid, publicKey: publicKeyPem(signing.publicKey) }]);

    const signedOut = await axios.get(h.url('/api/identity/go'), quiet);
    expect([signedOut.status, signedOut.headers.location]).toEqual([302, '/']);
    const signedIn = { ...quiet, headers: { Cookie: 'session=ok' } };
    expect((await axios.get(h.url('/api/identity/go'), signedIn)).status).toBe(404);
    await identity!.register({ id: 'inst-test', ownerId: TEST_USER.id, url: 'https://test.example.com' });

    expect((await axios.get(h.url('/api/identity/instance'))).data).toEqual({ instance: { id: 'inst-test', url: 'https://test.example.com' }, servesTenants: false });
    const go = await axios.get(h.url('/api/identity/go'), signedIn);
    expect(go.status).toBe(302);
    expect(go.headers.location).toMatch(/^https:\/\/test\.example\.com\/#\/handoff\?token=/);
    expect(go.headers['cache-control']).toBe('no-store');
    await h.close();
  });
});

describe('an instance\'s sign-in exchange', () => {
  it('turns root\'s token into this instance\'s own session, once, and points the signed-out at root', async () => {
    const sessionKey = 'instance-session-key';
    const h = await mountRouter({
      prefix: '/api/auth',
      router: (db) => {
        const role = { role: 'instance' as const, trusted: trustedKeys([publicKeyPem(signing.publicKey)]), instance: { id: 'inst-u1', ownerId: 'u1', rootUrl: 'https://app.example.com' } };
        return handoffRouter({ identity: new IdentityService(role, db), auth: createAuth({ db, sessionKey, publicUrl: 'http://x', role: 'instance' }), sessionKey });
      },
    });

    expect((await axios.get(h.url('/api/auth/sign-in'))).data).toEqual({ url: 'https://app.example.com/api/identity/go' });

    const token = issueHandoff(signing, { userId: 'u1', email: 'u1@example.com' }, 'inst-u1');
    const first = await axios.post(h.url('/api/auth/handoff'), { token }, { ...quiet, headers: { 'X-Forwarded-Proto': 'https' } });
    expect(first.status).toBe(200);
    const cookie = String(first.headers['set-cookie']?.[0]);
    expect(cookie).toMatch(/^session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(verifyJWT(cookie.split(';')[0]!.slice('session='.length), sessionKey)).toMatchObject({ userId: 'u1' });

    expect((await axios.post(h.url('/api/auth/handoff'), { token }, quiet)).status).toBe(409);
    expect((await axios.post(h.url('/api/auth/handoff'), {}, quiet)).status).toBe(400);
    await h.close();
  });
});
