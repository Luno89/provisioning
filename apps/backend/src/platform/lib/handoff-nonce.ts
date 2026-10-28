import { randomBytes, timingSafeEqual } from 'node:crypto';
import { signJWT, verifyJWT } from './auth.js';
import type { SecretKey } from './crypto.js';

export const HANDOFF_NONCE_COOKIE = 'handoff_nonce';
export const HANDOFF_NONCE_SECONDS = 10 * 60;

const NONCE = /^[A-Za-z0-9_-]{32}$/;

export const handoffNonceShaped = (value: unknown): value is string => typeof value === 'string' && NONCE.test(value);

export function newHandoffNonce(key: SecretKey): { nonce: string; cookie: string } {
  const nonce = randomBytes(24).toString('base64url');
  return { nonce, cookie: signJWT({ handoffNonce: nonce }, key, HANDOFF_NONCE_SECONDS) };
}

export function heldHandoffNonce(cookie: string | undefined, key: SecretKey): string | undefined {
  if (!cookie) return undefined;
  const held = verifyJWT(cookie, key)?.handoffNonce;
  return handoffNonceShaped(held) ? held : undefined;
}

export function sameHandoffNonce(held: string | undefined, claimed: unknown): boolean {
  if (!held || !handoffNonceShaped(claimed)) return false;
  const a = Buffer.from(held);
  const b = Buffer.from(claimed);
  return a.length === b.length && timingSafeEqual(a, b);
}
