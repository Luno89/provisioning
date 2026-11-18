import crypto from 'crypto';
import { decryptValue, encryptValue, sealedWithOtherKey, type Keyring } from './crypto.js';
import { KEY_NAMES } from './keys.js';
import { identityKeysFromSeed } from '../../instances/lib/identity-token.js';

export interface Reencrypted<T> {
  value: T;
  rewritten: string[];
  unreadable: string[];
}

const UNVERSIONED = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/;
const UNVERSIONED_SALT = 'ianthe-credential-encryption-v1';

export const needsReencryption = (encrypted: string, ring: Keyring): boolean =>
  UNVERSIONED.test(encrypted) || sealedWithOtherKey(encrypted, ring);

function openUnversioned(encrypted: string, ring: Keyring): string {
  const [ivHex, tagHex, body] = encrypted.split(':') as [string, string, string];
  let failure: unknown;
  for (const secret of [ring.current, ...(ring.previous ?? [])]) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(secret, UNVERSIONED_SALT, 32), Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return decipher.update(body, 'hex', 'utf8') + decipher.final('utf8');
    } catch (err) {
      failure = err;
    }
  }
  throw failure;
}

const opened = (sealed: string, ring: Keyring): string => (UNVERSIONED.test(sealed) ? openUnversioned(sealed, ring) : decryptValue(sealed, ring));

export function reencrypt<T>(value: T, ring: Keyring, at = ''): Reencrypted<T> {
  const rewritten: string[] = [];
  const unreadable: string[] = [];

  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === 'string') {
      if (!needsReencryption(node, ring)) return node;
      try {
        const plain = opened(node, ring);
        rewritten.push(path);
        return encryptValue(plain, ring);
      } catch {
        unreadable.push(path);
        return node;
      }
    }
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${path}[${index}]`));
    if (node && typeof node === 'object' && Object.getPrototypeOf(node) === Object.prototype) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, key === '_id' ? child : walk(child, path ? `${path}.${key}` : key)]));
    }
    return node;
  };

  return { value: walk(value, at) as T, rewritten, unreadable };
}

const LEGACY_SALT = 'nowrinkles-platform-keys';

const fromLegacy = (secret: string, purpose: string): Buffer => Buffer.from(crypto.hkdfSync('sha256', secret, LEGACY_SALT, purpose, 32));

export function sealedBeforeKeys(current: Keyring, jwtSecret: string | undefined, purpose: 'data'): Keyring {
  const legacy = jwtSecret?.trim();
  if (!legacy) return { current: current.current };
  const previous = [legacy, fromLegacy(legacy, purpose).toString('hex')].filter((key) => key !== current.current);
  return previous.length > 0 ? { current: current.current, previous } : { current: current.current };
}

export const identityKeyOf = (jwtSecret: string): string =>
  identityKeysFromSeed(fromLegacy(jwtSecret.trim(), 'identity')).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

export interface KeyLines {
  lines: string[];
  written: string[];
}

export function missingKeyLines(present: string, make: { key: () => string; identity: () => string }, jwtSecret: string | undefined): KeyLines {
  const written: string[] = Object.values(KEY_NAMES).filter((name) => !new RegExp(`^${name}=.{32,}$`, 'm').test(present));
  const lines = written.map((name) => `${name}=${make.key()}`);
  if (!/^ROOT_IDENTITY_KEY=.+$/m.test(present) && !/^ROLE=instance$/m.test(present)) {
    const legacy = jwtSecret?.trim();
    lines.push(`ROOT_IDENTITY_KEY=${Buffer.from(legacy ? identityKeyOf(legacy) : make.identity()).toString('base64')}`);
    written.push(legacy ? 'ROOT_IDENTITY_KEY (the one root signed with from JWT_SECRET, so whatever trusts root keeps trusting it)' : 'ROOT_IDENTITY_KEY');
  }
  return { lines, written };
}
