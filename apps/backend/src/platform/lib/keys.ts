import crypto from 'crypto';
import type { Keyring } from './crypto.js';

export interface PlatformKeys {
  session: Keyring;
  data: Keyring;
  payload: Keyring;
  egress: string;
  temporal: string;
}

export const KEY_NAMES = {
  session: 'SESSION_KEY',
  data: 'DATA_KEY',
  payload: 'PAYLOAD_KEY',
  egress: 'EGRESS_KEY',
  temporal: 'TEMPORAL_KEY',
} as const;

export type KeyPurpose = keyof typeof KEY_NAMES;

const PURPOSES = Object.keys(KEY_NAMES) as KeyPurpose[];

const MIN_LENGTH = 32;

type Env = Readonly<Record<string, string | undefined>>;

export class MissingKeysError extends Error {
  constructor(readonly missing: string[]) {
    super(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set, or shorter than ${MIN_LENGTH} characters. Run \`npm run keys -w apps/backend -- --write-env\` to generate them.`);
    this.name = 'MissingKeysError';
  }
}

export const generateKey = (): string => crypto.randomBytes(32).toString('hex');

const given = (env: Env, purpose: KeyPurpose): string | undefined => {
  const value = env[KEY_NAMES[purpose]]?.trim();
  return value && value.length >= MIN_LENGTH ? value : undefined;
};

const shaped = <P extends KeyPurpose>(purpose: P, value: string): PlatformKeys[P] =>
  (purpose === 'egress' || purpose === 'temporal' ? value : { current: value }) as PlatformKeys[P];

export function loadKeys(env: Env): PlatformKeys {
  const missing = PURPOSES.filter((purpose) => !given(env, purpose));
  if (missing.length > 0) throw new MissingKeysError(missing.map((purpose) => KEY_NAMES[purpose]));
  const key = <P extends KeyPurpose>(purpose: P): PlatformKeys[P] => shaped(purpose, given(env, purpose)!);
  return { session: key('session'), data: key('data'), payload: key('payload'), egress: key('egress'), temporal: key('temporal') };
}

export function loadKey<P extends KeyPurpose>(env: Env, purpose: P): PlatformKeys[P] {
  const value = given(env, purpose);
  if (!value) throw new MissingKeysError([KEY_NAMES[purpose]]);
  return shaped(purpose, value);
}
