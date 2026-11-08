import { createHash } from 'node:crypto';
import { KEY_NAMES, loadKeys, type PlatformKeys } from '../lib/keys.js';
import { generateIdentityKey } from '../../instances/lib/identity-token.js';

export const testKeyEnv = (seed: string): Record<string, string> =>
  Object.fromEntries(Object.values(KEY_NAMES).map((name) => [name, createHash('sha256').update(`${seed}:${name}`).digest('hex')]));

export const testKeys = (seed: string): PlatformKeys => loadKeys(testKeyEnv(seed));

export const testIdentityKey = (): string => Buffer.from(generateIdentityKey()).toString('base64');
