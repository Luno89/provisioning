import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { TEMPORAL_RENEW_SECONDS, TEMPORAL_TOKEN_SECONDS, temporalApiKey, temporalJwks, temporalNamespaceFrom, temporalToken } from './temporal-auth.js';

const SECRET = 'k'.repeat(64);
const GRANT = { subject: 'koala-worker-engine', namespace: 'default', role: 'write' as const };

const decoded = (token: string) => {
  const [header, payload, signature] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header!, 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>,
    signed: `${header}.${payload}`,
    signature: Buffer.from(signature!, 'base64url'),
  };
};

const verifiesWith = (token: string, jwks: { keys: readonly { kid: string; kty: string; crv: string; x: string; y: string }[] }): boolean => {
  const { header, signed, signature } = decoded(token);
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (!jwk) return false;
  const { kty, crv, x, y } = jwk;
  return crypto.verify('sha256', Buffer.from(signed), { key: crypto.createPublicKey({ key: { kty, crv, x, y }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, signature);
};

describe('the tokens Koala signs for its Temporal', () => {
  it('signs ES256 tokens that the published key verifies, as Temporal\'s own key provider reads it', () => {
    const jwks = temporalJwks(SECRET);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.keys[0]).not.toHaveProperty('d');
    const token = temporalToken(SECRET, GRANT);
    expect(decoded(token).header).toEqual({ alg: 'ES256', typ: 'JWT', kid: jwks.keys[0]!.kid });
    expect(verifiesWith(token, jwks)).toBe(true);
  });

  it('grants one role on one namespace, for an hour', () => {
    const now = Date.UTC(2026, 9, 27, 12, 0, 0);
    const { payload } = decoded(temporalToken(SECRET, GRANT, now));
    expect(payload).toEqual({ sub: 'koala-worker-engine', permissions: ['default:write'], iat: now / 1000, exp: now / 1000 + TEMPORAL_TOKEN_SECONDS });
    expect(decoded(temporalToken(SECRET, { ...GRANT, role: 'admin' }, now)).payload.permissions).toEqual(['default:admin']);
  });

  it('derives the same key from the same secret in every process, and another from another', () => {
    expect(temporalJwks(SECRET)).toEqual(temporalJwks('k'.repeat(64)));
    const other = temporalJwks('o'.repeat(64));
    expect(other.keys[0]!.kid).not.toBe(temporalJwks(SECRET).keys[0]!.kid);
    expect(verifiesWith(temporalToken('o'.repeat(64), GRANT), temporalJwks(SECRET))).toBe(false);
  });

  it('hands out the same token until it is close to expiring, then a fresh one', () => {
    let now = Date.UTC(2026, 9, 27, 12, 0, 0);
    const apiKey = temporalApiKey(SECRET, GRANT, () => now);
    const first = apiKey();
    now += (TEMPORAL_TOKEN_SECONDS - TEMPORAL_RENEW_SECONDS) * 1000 - 1;
    expect(apiKey()).toBe(first);
    now += 1;
    const renewed = apiKey();
    expect(renewed).not.toBe(first);
    expect((decoded(renewed).payload.exp as number) * 1000 - now).toBe(TEMPORAL_TOKEN_SECONDS * 1000);
  });

  it('reads the namespace from the environment, default when unset', () => {
    expect(temporalNamespaceFrom({})).toBe('default');
    expect(temporalNamespaceFrom({ TEMPORAL_NAMESPACE: ' koala ' })).toBe('koala');
  });
});
