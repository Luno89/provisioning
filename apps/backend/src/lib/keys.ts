import crypto from 'crypto';
import type { Keyring } from './crypto.js';

export interface PlatformKeys {
  session: Keyring;
  data: Keyring;
  payload: Keyring;
  egress: string;
}

export const KEY_NAMES = {
  session: 'SESSION_KEY',
  data: 'DATA_KEY',
  payload: 'PAYLOAD_KEY',
  egress: 'EGRESS_KEY',
} as const;

export type KeyPurpose = keyof typeof KEY_NAMES;

const MIN_LENGTH = 32;
const DEV_SECRET = 'provisioning-platform-secret-12345';

export class MissingKeysError extends Error {
  constructor(readonly missing: string[]) {
    super(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set, or shorter than ${MIN_LENGTH} characters. Run \`npm run keys -w apps/backend -- --write-env\` to generate them.`);
    this.name = 'MissingKeysError';
  }
}

export const generateKey = (): string => crypto.randomBytes(32).toString('hex');

const derive = (root: string, purpose: KeyPurpose): string =>
  Buffer.from(crypto.hkdfSync('sha256', root, 'nowrinkles-platform-keys', purpose, 32)).toString('hex');

export function loadKeys(env: Readonly<Record<string, string | undefined>>): PlatformKeys {
  const production = env.NODE_ENV === 'production';
  const legacy = env.JWT_SECRET?.trim() || undefined;
  const given = (purpose: KeyPurpose): string | undefined => {
    const value = env[KEY_NAMES[purpose]]?.trim();
    return value && value.length >= MIN_LENGTH ? value : undefined;
  };

  const missing = (Object.keys(KEY_NAMES) as KeyPurpose[]).filter((purpose) => !given(purpose));
  if (production && missing.length > 0) throw new MissingKeysError(missing.map((purpose) => KEY_NAMES[purpose]));

  const old = legacy ?? (production ? undefined : DEV_SECRET);
  const key = (purpose: KeyPurpose): string => given(purpose) ?? derive(old ?? DEV_SECRET, purpose);
  const ring = (purpose: KeyPurpose): Keyring => {
    const current = key(purpose);
    const previous = old ? [...new Set([old, derive(old, purpose)])].filter((candidate) => candidate !== current) : [];
    return previous.length > 0 ? { current, previous } : { current };
  };

  return { session: ring('session'), data: ring('data'), payload: ring('payload'), egress: key('egress') };
}
