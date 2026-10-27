import crypto from 'crypto';

export type TemporalRole = 'read' | 'write' | 'admin';

export interface TemporalGrant {
  subject: string;
  namespace: string;
  role: TemporalRole;
}

export interface TemporalJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

export const TEMPORAL_JWKS_PATH = '/.well-known/temporal-jwks.json';
export const TEMPORAL_TOKEN_SECONDS = 60 * 60;
export const TEMPORAL_RENEW_SECONDS = 20 * 60;

const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

interface SigningKey {
  privateKey: crypto.KeyObject;
  jwk: TemporalJwk;
}

const signingKeys = new Map<string, SigningKey>();

export function temporalSigningKey(secret: string): SigningKey {
  const known = signingKeys.get(secret);
  if (known) return known;
  for (let round = 0; ; round += 1) {
    const scalar = Buffer.from(crypto.hkdfSync('sha256', secret, 'nowrinkles-temporal-jwt', `p256-${round}`, 32));
    const value = BigInt(`0x${scalar.toString('hex')}`);
    if (value === 0n || value >= P256_ORDER) continue;
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(scalar);
    const point = ecdh.getPublicKey();
    const thumbprinted = { crv: 'P-256', kty: 'EC', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } as const;
    const kid = crypto.createHash('sha256').update(JSON.stringify(thumbprinted)).digest('base64url');
    const privateKey = crypto.createPrivateKey({ key: { ...thumbprinted, d: scalar.toString('base64url') }, format: 'jwk' });
    const key: SigningKey = { privateKey, jwk: { kty: 'EC', crv: 'P-256', x: thumbprinted.x, y: thumbprinted.y, kid, alg: 'ES256', use: 'sig' } };
    signingKeys.set(secret, key);
    return key;
  }
}

export const temporalJwks = (secret: string): { keys: TemporalJwk[] } => ({ keys: [temporalSigningKey(secret).jwk] });

const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export function temporalToken(secret: string, grant: TemporalGrant, now = Date.now()): string {
  const { privateKey, jwk } = temporalSigningKey(secret);
  const issued = Math.floor(now / 1000);
  const unsigned = `${part({ alg: 'ES256', typ: 'JWT', kid: jwk.kid })}.${part({
    sub: grant.subject,
    permissions: [`${grant.namespace}:${grant.role}`],
    iat: issued,
    exp: issued + TEMPORAL_TOKEN_SECONDS,
  })}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${signature.toString('base64url')}`;
}

export function temporalApiKey(secret: string, grant: TemporalGrant, clock: () => number = Date.now): () => string {
  let token = '';
  let renewAt = 0;
  return () => {
    const now = clock();
    if (now >= renewAt) {
      token = temporalToken(secret, grant, now);
      renewAt = now + (TEMPORAL_TOKEN_SECONDS - TEMPORAL_RENEW_SECONDS) * 1000;
    }
    return token;
  };
}

export const temporalNamespaceFrom = (env: Readonly<Record<string, string | undefined>>): string => env.TEMPORAL_NAMESPACE?.trim() || 'default';
