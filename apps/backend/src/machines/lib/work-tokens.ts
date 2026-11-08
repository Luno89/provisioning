import crypto from 'crypto';
import type { IdentityKeyPair } from '../../instances/index.js';

export const WORK_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
export const WORK_TOKEN_RENEW_SECONDS = 7 * 24 * 3600;
const ALG = 'EdDSA';
const TYP = 'nowrinkles-machine';

export interface WorkClaims {
  sub: string;
  owner: string;
  aud: string;
  iat: number;
  exp: number;
}

export type WorkCheck =
  | { ok: true; claims: WorkClaims }
  | { ok: false; reason: 'malformed' | 'unknown-key' | 'bad-signature' | 'wrong-audience' | 'expired' | 'not-yet-valid' };

const b64 = (value: Buffer | string): string => Buffer.from(value).toString('base64url');
const fromB64 = (value: string): Buffer => Buffer.from(value, 'base64url');

const record = (text: string): Record<string, unknown> | undefined => {
  const value: unknown = JSON.parse(text);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
};

export function issueWorkToken(
  keys: IdentityKeyPair,
  machine: { machineId: string; ownerId: string; audience: string },
  now: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: ALG, typ: TYP, kid: keys.kid };
  const claims: WorkClaims = { sub: machine.machineId, owner: machine.ownerId, aud: machine.audience, iat: now, exp: now + WORK_TOKEN_TTL_SECONDS };
  const signed = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  return `${signed}.${b64(crypto.sign(null, Buffer.from(signed), keys.privateKey))}`;
}

export function checkWorkToken(
  token: unknown,
  trusted: ReadonlyMap<string, crypto.KeyObject>,
  audience: string,
  now: number = Math.floor(Date.now() / 1000),
): WorkCheck {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [head, body, signature] = parts as [string, string, string];
  let header: Record<string, unknown> | undefined;
  let claims: Record<string, unknown> | undefined;
  try {
    header = record(fromB64(head).toString('utf8'));
    claims = record(fromB64(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!header || !claims || header.alg !== ALG || header.typ !== TYP || typeof header.kid !== 'string') return { ok: false, reason: 'malformed' };
  const key = trusted.get(header.kid);
  if (!key) return { ok: false, reason: 'unknown-key' };
  if (!crypto.verify(null, Buffer.from(`${head}.${body}`), key, fromB64(signature))) return { ok: false, reason: 'bad-signature' };
  const { sub, owner, aud, iat, exp } = claims;
  if (typeof sub !== 'string' || !sub || typeof owner !== 'string' || !owner || typeof aud !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') return { ok: false, reason: 'malformed' };
  if (aud !== audience) return { ok: false, reason: 'wrong-audience' };
  if (exp <= now) return { ok: false, reason: 'expired' };
  if (iat > now + 30) return { ok: false, reason: 'not-yet-valid' };
  return { ok: true, claims: { sub, owner, aud, iat, exp } };
}

export const workTokenRenewDue = (claims: Pick<WorkClaims, 'exp'>, now: number = Math.floor(Date.now() / 1000)): boolean =>
  claims.exp - now <= WORK_TOKEN_RENEW_SECONDS;

export const WORK_TOKEN_REFUSED: Record<Exclude<WorkCheck, { ok: true }>['reason'], string> = {
  malformed: 'this machine connected without a work token from root: run the command from My Machines again',
  'unknown-key': 'this machine\'s work token was not signed by this Koala\'s root: run the command from My Machines again',
  'bad-signature': 'this machine\'s work token does not verify',
  'wrong-audience': 'this machine\'s work token is for another Koala',
  expired: 'this machine\'s work token expired; it asks root for a new one when it next connects there',
  'not-yet-valid': 'this machine\'s work token is dated in the future; check its clock',
};
