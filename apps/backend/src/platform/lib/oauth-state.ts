import { randomBytes, timingSafeEqual } from 'node:crypto';
import { signJWT, verifyJWT } from './auth.js';
import type { SecretKey } from './crypto.js';

export const OAUTH_STATE_COOKIE = 'oauth_state';
export const OAUTH_STATE_SECONDS = 10 * 60;

export function newOAuthState(carried: string, key: SecretKey): { state: string; cookie: string } {
  const state = randomBytes(24).toString('base64url');
  return { state, cookie: signJWT({ oauthState: state, carried }, key, OAUTH_STATE_SECONDS) };
}

export function carriedByOAuthState(cookie: string | undefined, state: unknown, key: SecretKey): { carried: string } | undefined {
  if (!cookie || typeof state !== 'string') return undefined;
  const held = verifyJWT(cookie, key);
  if (typeof held?.oauthState !== 'string') return undefined;
  const expected = Buffer.from(held.oauthState);
  const given = Buffer.from(state);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  return { carried: typeof held.carried === 'string' ? held.carried : '' };
}
