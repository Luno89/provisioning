import { createHash } from 'node:crypto';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { startStandInIssuer, type StandInIssuer } from './stand-in-issuer.js';

const REDIRECT = 'https://app.example.test/api/auth/provider/oidc/callback';
const person = { sub: 'sub-1', email: 'ann@example.com', email_verified: true };

let issuer: StandInIssuer | undefined;
afterEach(async () => { await issuer?.close(); issuer = undefined; });

const VERIFIER = 'a-verifier-of-sufficient-length-for-pkce-123456';

function authorizationUrl(of: StandInIssuer, extra: Record<string, string> = {}): string {
  const url = new URL(`${of.issuer}/auth`);
  for (const [key, value] of Object.entries({
    client_id: of.clientId, response_type: 'code', redirect_uri: REDIRECT, scope: 'openid email profile', state: 'state-1', nonce: 'nonce-1',
    code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'), code_challenge_method: 'S256', ...extra,
  })) url.searchParams.set(key, value);
  return url.href;
}

async function signedIn(of: StandInIssuer): Promise<string> {
  const back = await of.authorize(authorizationUrl(of));
  const code = back.searchParams.get('code');
  if (!code) throw new Error(`no code came back: ${back.href}`);
  const answer = await fetch(`${of.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: of.clientId, client_secret: of.clientSecret, code_verifier: VERIFIER }),
  });
  const tokens = await answer.json() as { id_token?: string; error?: string };
  if (!tokens.id_token) throw new Error(`no ID token: ${JSON.stringify(tokens)}`);
  return tokens.id_token;
}

const keysOf = async (of: StandInIssuer) => createLocalJWKSet(await (await fetch(`${of.issuer}/jwks`)).json() as Parameters<typeof createLocalJWKSet>[0]);

describe('the stand-in OpenID provider on a real socket', () => {
  it('serves its own discovery document at the loopback address it listens on, and keeps the client credentials it was given', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT], clientId: 'koala-test', clientSecret: 'the-secret' });
    expect(issuer.issuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect([issuer.clientId, issuer.clientSecret]).toEqual(['koala-test', 'the-secret']);
    const found = await (await fetch(`${issuer.issuer}/.well-known/openid-configuration`)).json() as { issuer: string; authorization_endpoint: string };
    expect(found.issuer).toBe(issuer.issuer);
    expect(found.authorization_endpoint).toBe(`${issuer.issuer}/auth`);
  });

  it('makes up a client id and secret of its own when none are given', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    expect(issuer.clientId).toBe('koala-sign-in');
    expect(issuer.clientSecret).toMatch(/^secret-/);
  });

  it('signs the person it was told to sign in, sending the browser back to the app with a code and the state, and remembers what it was asked', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    issuer.signInAs(person);
    expect(issuer.asked()).toEqual([]);
    const back = await issuer.authorize(authorizationUrl(issuer));
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('state-1');
    expect(back.searchParams.get('code')).toEqual(expect.any(String));
    const [asked] = issuer.asked();
    expect(asked?.get('nonce')).toBe('nonce-1');
    expect(asked?.get('code_challenge_method')).toBe('S256');
    expect(issuer.asked()).toHaveLength(1);
  });

  it('gives an ID token that names the person, their address and whether it was verified, signed with its published key', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    issuer.signInAs(person);
    const token = await signedIn(issuer);
    const { payload } = await jwtVerify(token, await keysOf(issuer), { issuer: issuer.issuer, audience: issuer.clientId });
    expect(payload).toMatchObject({ sub: 'sub-1', email: 'ann@example.com', email_verified: true, nonce: 'nonce-1' });
  });

  it('refuses the sign-in when nobody was told to sign in, sending the browser back with the refusal', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    const back = await issuer.authorize(authorizationUrl(issuer));
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('forges what it was told to, and only that', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    issuer.signInAs(person);
    const keys = await keysOf(issuer);

    issuer.mischief('signature');
    await expect(jwtVerify(await signedIn(issuer), keys)).rejects.toThrow();

    issuer.mischief('audience');
    expect(decodeJwt(await signedIn(issuer)).aud).toBe('someone-else');

    issuer.mischief('nonce');
    expect(decodeJwt(await signedIn(issuer)).nonce).toBe('a-nonce-nobody-sent');

    issuer.mischief('issuer');
    expect(decodeJwt(await signedIn(issuer)).iss).toBe('https://pretender.example.com');

    issuer.mischief('none');
    await expect(jwtVerify(await signedIn(issuer), keys, { issuer: issuer.issuer, audience: issuer.clientId })).resolves.toBeDefined();
  });

  it('will not send a browser that was not sent to it, and says where it got stuck when it cannot go on', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    await expect(issuer.authorize('https://elsewhere.example.test/auth')).rejects.toThrow(`the sign-in was sent to https://elsewhere.example.test, not the stand-in ${issuer.issuer}`);
    await expect(issuer.authorize(`${issuer.issuer}/nowhere`)).rejects.toThrow(/the stand-in issuer stopped at \/nowhere: 404/);
  });

  it('stops listening when closed', async () => {
    const closing = await startStandInIssuer({ redirectUris: [REDIRECT] });
    const address = closing.issuer;
    await expect(closing.close()).resolves.toBeUndefined();
    await expect(fetch(`${address}/.well-known/openid-configuration`)).rejects.toThrow();
  });
});
