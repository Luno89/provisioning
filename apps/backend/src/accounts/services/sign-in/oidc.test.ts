import { createHash } from 'node:crypto';
import * as client from 'openid-client';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from 'jose';
import { http, HttpResponse } from 'msw';
import { beforeAll, describe, expect, it } from 'vitest';
import { interceptHttp } from '../../../platform/testing/http.js';
import { SignInRefusal, type SignInChecks, type SignInProvider } from '../../lib/sign-in-providers.js';
import { oidcSignIn, reachedOverPlainHttp } from './oidc.js';

const ISSUER = 'https://idp.example.test';
const REDIRECT = 'https://app.example.test/api/auth/provider/oidc/callback';
const checks: SignInChecks = { state: 'state-1', verifier: 'a-verifier-of-sufficient-length-for-pkce-123456', nonce: 'nonce-1' };

const oidc = (issuer = ISSUER): SignInProvider => ({ id: 'oidc', label: 'Your organisation', kind: 'oidc', issuer, scopes: ['openid', 'email', 'profile'], clientId: 'client-1', clientSecret: 'secret-1' });

let signing: CryptoKey;
let publicJwk: JWK;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signing = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  otherKey = (await generateKeyPair('RS256')).privateKey;
});

const discovery = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  token_endpoint_auth_methods_supported: ['client_secret_post'],
});

let idToken: () => Promise<string>;
let discoveryHits = 0;
let discoveryFails = 0;
const seen: { token?: URLSearchParams } = {};

const token = async (claims: Record<string, unknown> = {}, key: CryptoKey = signing) => new SignJWT({ email: 'Ann@Example.com', email_verified: true, nonce: 'nonce-1', ...claims })
  .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience('client-1').setSubject('sub-1').setIssuedAt().setExpirationTime('5m').sign(key);

interceptHttp(
  http.get(`${ISSUER}/.well-known/openid-configuration`, () => {
    discoveryHits += 1;
    if (discoveryFails > 0) { discoveryFails -= 1; return new HttpResponse('down', { status: 503 }); }
    return HttpResponse.json(discovery(ISSUER));
  }),
  http.get(`${ISSUER}/jwks`, () => HttpResponse.json({ keys: [publicJwk] })),
  http.post(`${ISSUER}/token`, async ({ request }) => {
    seen.token = new URLSearchParams(await request.text());
    return HttpResponse.json({ access_token: 'at', token_type: 'bearer', id_token: await idToken() });
  }),
  http.get('http://127.0.0.1:4545/.well-known/openid-configuration', () => HttpResponse.json(discovery('http://127.0.0.1:4545'))),
);

const callback = new URL(`${REDIRECT}?code=the-code&state=state-1`);

describe('signing in with an OpenID provider', () => {
  it('sends the person to the provider it discovered, with a PKCE challenge of the verifier, the state and the nonce', async () => {
    idToken = () => token();
    const url = await oidcSignIn(oidc()).authorizationUrl(REDIRECT, checks);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-1', response_type: 'code', redirect_uri: REDIRECT, scope: 'openid email profile', state: 'state-1', nonce: 'nonce-1',
      code_challenge: createHash('sha256').update(checks.verifier).digest('base64url'), code_challenge_method: 'S256',
    });
  });

  it('exchanges the code with the verifier and reads who the signed ID token says it is', async () => {
    idToken = () => token();
    expect(await oidcSignIn(oidc()).identify(callback, checks)).toEqual({ subject: 'sub-1', email: 'ann@example.com', verified: true });
    expect(seen.token?.get('code')).toBe('the-code');
    expect(seen.token?.get('code_verifier')).toBe(checks.verifier);
  });

  it('discovers the provider once however often it is used', async () => {
    idToken = () => token();
    discoveryHits = 0;
    const signIn = oidcSignIn(oidc());
    await signIn.authorizationUrl(REDIRECT, checks);
    await signIn.identify(callback, checks);
    await signIn.authorizationUrl(REDIRECT, checks);
    expect(discoveryHits).toBe(1);
  });

  it('asks again after a discovery that failed', async () => {
    discoveryFails = 1;
    const signIn = oidcSignIn(oidc());
    await expect(signIn.authorizationUrl(REDIRECT, checks)).rejects.toThrow();
    await Promise.resolve();
    expect((await signIn.authorizationUrl(REDIRECT, checks)).pathname).toBe('/authorize');
  });

  it('refuses an ID token for another nonce, another audience or signed with another key', async () => {
    const signIn = oidcSignIn(oidc());
    idToken = () => token({ nonce: 'a-nonce-nobody-sent' });
    await expect(signIn.identify(callback, checks)).rejects.toThrow();
    idToken = async () => new SignJWT({ email: 'ann@example.com', nonce: 'nonce-1' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience('someone-else').setSubject('sub-1').setIssuedAt().setExpirationTime('5m').sign(signing);
    await expect(signIn.identify(callback, checks)).rejects.toThrow();
    idToken = () => token({}, otherKey);
    await expect(signIn.identify(callback, checks)).rejects.toThrow();
  });

  it('refuses an ID token that names nobody or gives no address', async () => {
    const signIn = oidcSignIn(oidc());
    idToken = () => token({ email: undefined });
    await expect(signIn.identify(callback, checks)).rejects.toThrow(new SignInRefusal('it gave no email address'));
  });

  it('refuses a callback whose state is not the one held', async () => {
    idToken = () => token();
    await expect(oidcSignIn(oidc()).identify(new URL(`${REDIRECT}?code=c&state=another`), checks)).rejects.toThrow();
  });

  it('reaches a provider on this machine over plain http, and no other', async () => {
    expect(reachedOverPlainHttp(oidc('http://127.0.0.1:4545'))).toEqual([client.allowInsecureRequests]);
    expect(reachedOverPlainHttp(oidc('http://localhost:4545'))).toEqual([client.allowInsecureRequests]);
    expect(reachedOverPlainHttp(oidc('https://idp.example.test'))).toEqual([]);
    expect(reachedOverPlainHttp(oidc('http://idp.example.test'))).toEqual([]);
    const url = await oidcSignIn(oidc('http://127.0.0.1:4545')).authorizationUrl(REDIRECT, checks);
    expect(url.origin).toBe('http://127.0.0.1:4545');
  });
});
