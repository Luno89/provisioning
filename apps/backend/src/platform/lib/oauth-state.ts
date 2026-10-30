import { randomBytes, timingSafeEqual } from 'node:crypto';
import { signJWT, verifyJWT } from './auth.js';
import type { SecretKey } from './crypto.js';

export const OAUTH_STATE_COOKIE = 'oauth_state';
export const OAUTH_STATE_SECONDS = 10 * 60;

export type HeldWithState = Readonly<Record<string, string>>;

export function newOAuthState(carried: string, key: SecretKey, held: HeldWithState = {}): { state: string; cookie: string } {
  const state = randomBytes(24).toString('base64url');
  return { state, cookie: signJWT('oauth-state', { oauthState: state, carried, held }, key, OAUTH_STATE_SECONDS) };
}

export function carriedByOAuthState(cookie: string | undefined, state: unknown, key: SecretKey): { carried: string; state: string; held: HeldWithState } | undefined {
  if (!cookie || typeof state !== 'string') return undefined;
  const signed = verifyJWT(cookie, 'oauth-state', key);
  if (typeof signed?.oauthState !== 'string') return undefined;
  const expected = Buffer.from(signed.oauthState);
  const given = Buffer.from(state);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  const held = signed.held && typeof signed.held === 'object'
    ? Object.fromEntries(Object.entries(signed.held as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {};
  return { carried: typeof signed.carried === 'string' ? signed.carried : '', state, held };
}
