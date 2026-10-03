import crypto from 'crypto';

export const HANDOFF_TTL_SECONDS = 60;
const ALG = 'EdDSA';
const TYP = 'nowrinkles-handoff';

export interface HandoffClaims {
  sub: string;
  email: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface IdentityKeyPair {
  kid: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

export type HandoffCheck =
  | { ok: true; claims: HandoffClaims }
  | { ok: false; reason: 'malformed' | 'unknown-key' | 'bad-signature' | 'wrong-audience' | 'expired' | 'not-yet-valid' };

const b64 = (value: Buffer | string): string => Buffer.from(value).toString('base64url');
const fromB64 = (value: string): Buffer => Buffer.from(value, 'base64url');

export const publicKeyPem = (key: crypto.KeyObject): string => key.export({ type: 'spki', format: 'pem' }).toString();

export const kidOf = (publicKey: crypto.KeyObject): string =>
  crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

export function identityKeysFrom(privateKeyPem: string): IdentityKeyPair {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the identity key has to be an Ed25519 private key');
  const publicKey = crypto.createPublicKey(privateKey);
  return { kid: kidOf(publicKey), privateKey, publicKey };
}

export function identityKeysFromSeed(seed: Buffer): IdentityKeyPair {
  if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = crypto.createPublicKey(privateKey);
  return { kid: kidOf(publicKey), privateKey, publicKey };
}

export const generateIdentityKey = (): string =>
  crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

export function issueHandoff(
  keys: IdentityKeyPair,
  who: { userId: string; email: string },
  audience: string,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: ALG, typ: TYP, kid: keys.kid };
  const claims: HandoffClaims = {
    sub: who.userId,
    email: who.email,
    aud: audience,
    iat: now,
    exp: now + HANDOFF_TTL_SECONDS,
    jti: crypto.randomUUID(),
  };
  const signed = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  return `${signed}.${b64(crypto.sign(null, Buffer.from(signed), keys.privateKey))}`;
}

export function checkHandoff(
  token: string,
  trusted: ReadonlyMap<string, crypto.KeyObject>,
  audience: string,
  now: number = Math.floor(Date.now() / 1000),
): HandoffCheck {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [head, body, signature] = parts as [string, string, string];

  let header: { alg?: unknown; typ?: unknown; kid?: unknown };
  let claims: Partial<HandoffClaims>;
  try {
    header = JSON.parse(fromB64(head).toString('utf8'));
    claims = JSON.parse(fromB64(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== ALG || header.typ !== TYP || typeof header.kid !== 'string') return { ok: false, reason: 'malformed' };

  const key = trusted.get(header.kid);
  if (!key) return { ok: false, reason: 'unknown-key' };
  if (!crypto.verify(null, Buffer.from(`${head}.${body}`), key, fromB64(signature))) return { ok: false, reason: 'bad-signature' };

  const complete = typeof claims.sub === 'string' && typeof claims.email === 'string' && typeof claims.aud === 'string'
    && typeof claims.iat === 'number' && typeof claims.exp === 'number' && typeof claims.jti === 'string';
  if (!complete) return { ok: false, reason: 'malformed' };
  if (claims.aud !== audience) return { ok: false, reason: 'wrong-audience' };
  if (claims.exp! <= now) return { ok: false, reason: 'expired' };
  if (claims.iat! > now + 30) return { ok: false, reason: 'not-yet-valid' };
  return { ok: true, claims: claims as HandoffClaims };
}

export function trustedKeys(publicKeyPems: readonly string[]): Map<string, crypto.KeyObject> {
  return new Map(publicKeyPems.map((pem) => {
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('a trusted identity key has to be an Ed25519 public key');
    return [kidOf(key), key] as const;
  }));
}
