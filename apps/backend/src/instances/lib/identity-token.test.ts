import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  HANDOFF_TTL_SECONDS,
  checkHandoff,
  generateIdentityKey,
  identityKeysFrom,
  identityKeysFromSeed,
  issueHandoff,
  publicKeyPem,
  trustedKeys,
} from './identity-token.js';

const root = identityKeysFrom(generateIdentityKey());
const trusted = trustedKeys([publicKeyPem(root.publicKey)]);
const who = { userId: 'u1', email: 'u1@example.com' };
const NOW = 1_800_000_000;

describe('the token root hands a signed-in user to their instance', () => {
  it('carries who they are and which instance it is for, and checks out at that instance', () => {
    const check = checkHandoff(issueHandoff(root, who, 'inst-u1', NOW), trusted, 'inst-u1', NOW + 5);

    expect(check).toMatchObject({ ok: true, claims: { sub: 'u1', email: 'u1@example.com', aud: 'inst-u1', iat: NOW, exp: NOW + HANDOFF_TTL_SECONDS } });
    expect(check.ok && check.claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is refused by any other instance, so one user\'s token never opens another\'s', () => {
    expect(checkHandoff(issueHandoff(root, who, 'inst-u1', NOW), trusted, 'inst-u2', NOW)).toEqual({ ok: false, reason: 'wrong-audience' });
  });

  it('lasts a minute', () => {
    const token = issueHandoff(root, who, 'inst-u1', NOW);
    expect(checkHandoff(token, trusted, 'inst-u1', NOW + HANDOFF_TTL_SECONDS)).toEqual({ ok: false, reason: 'expired' });
    expect(checkHandoff(token, trusted, 'inst-u1', NOW - 60)).toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  it('is refused when signed by a key the instance does not trust, or changed after signing', () => {
    const stranger = identityKeysFrom(generateIdentityKey());
    expect(checkHandoff(issueHandoff(stranger, who, 'inst-u1', NOW), trusted, 'inst-u1', NOW)).toEqual({ ok: false, reason: 'unknown-key' });

    const [head, body, sig] = issueHandoff(root, who, 'inst-u1', NOW).split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = `${head}.${Buffer.from(JSON.stringify({ ...claims, sub: 'admin' })).toString('base64url')}.${sig}`;
    expect(checkHandoff(forged, trusted, 'inst-u1', NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses anything that is not one of its tokens, including an HMAC-signed session cookie', () => {
    expect(checkHandoff('not.a.token', trusted, 'inst-u1', NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(checkHandoff('', trusted, 'inst-u1', NOW)).toEqual({ ok: false, reason: 'malformed' });
    const hs256 = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.x`;
    expect(checkHandoff(hs256, trusted, 'inst-u1', NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('derives the same key from the same seed, for development without a stored key', () => {
    const seed = crypto.randomBytes(32);
    expect(identityKeysFromSeed(seed).kid).toBe(identityKeysFromSeed(seed).kid);
    expect(identityKeysFromSeed(seed).kid).not.toBe(identityKeysFromSeed(crypto.randomBytes(32)).kid);
  });
});
