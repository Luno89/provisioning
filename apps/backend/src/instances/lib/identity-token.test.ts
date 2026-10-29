import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  HANDOFF_TTL_SECONDS,
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

const signedBy = (token: string, key: crypto.KeyObject): boolean => {
  const [head, body, sig] = token.split('.') as [string, string, string];
  return crypto.verify(null, Buffer.from(`${head}.${body}`), key, Buffer.from(sig, 'base64url'));
};
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

describe('the token root still hands a signed-in user to an instance on an older release', () => {
  it('carries who they are, which instance it is for and the nonce that instance set, for a minute, signed by root', () => {
    const token = issueHandoff(root, who, 'inst-u1', NOW, 'n'.repeat(32));
    expect(signedBy(token, [...trusted.values()][0]!)).toBe(true);
    expect(claimsOf(token)).toMatchObject({ sub: 'u1', email: 'u1@example.com', aud: 'inst-u1', iat: NOW, exp: NOW + HANDOFF_TTL_SECONDS, nonce: 'n'.repeat(32) });
    expect(claimsOf(token).jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is signed so that a changed claim no longer verifies', () => {
    const [head, body, sig] = issueHandoff(root, who, 'inst-u1', NOW).split('.') as [string, string, string];
    const forged = `${head}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), sub: 'admin' })).toString('base64url')}.${sig}`;
    expect(signedBy(forged, root.publicKey)).toBe(false);
  });

  it('derives the same key from the same seed, for development without a stored key', () => {
    const seed = crypto.randomBytes(32);
    expect(identityKeysFromSeed(seed).kid).toBe(identityKeysFromSeed(seed).kid);
    expect(identityKeysFromSeed(seed).kid).not.toBe(identityKeysFromSeed(crypto.randomBytes(32)).kid);
  });
});
