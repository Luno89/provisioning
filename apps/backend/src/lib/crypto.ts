import crypto from 'crypto';

const CREDENTIAL_SALT = 'ianthe-credential-encryption-v1';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const VERSION = 'v2';

export interface Keyring {
  current: string;
  previous?: readonly string[] | undefined;
}

export type SecretKey = string | Keyring;

const derived = new Map<string, Buffer>();

function deriveKey(masterSecret: string): Buffer {
  let key = derived.get(masterSecret);
  if (!key) {
    key = crypto.scryptSync(masterSecret, CREDENTIAL_SALT, KEY_LENGTH);
    derived.set(masterSecret, key);
  }
  return key;
}

export const ringOf = (key: SecretKey): Keyring => (typeof key === 'string' ? { current: key } : key);

export const keyId = (secret: string): string => crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);

const LEGACY = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/;
const VERSIONED = /^v2:[0-9a-f]{8}:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/;

export const looksEncrypted = (value: string): boolean => LEGACY.test(value) || VERSIONED.test(value);

export function encryptValue(plaintext: string, key: SecretKey): string {
  const secret = ringOf(key).current;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return `${VERSION}:${keyId(secret)}:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
}

function open(secret: string, ivHex: string, authTagHex: string, ciphertext: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function decryptValue(encrypted: string, key: SecretKey): string {
  const ring = ringOf(key);
  const secrets = [ring.current, ...(ring.previous ?? [])];
  const parts = encrypted.split(':');

  if (parts.length === 5 && parts[0] === VERSION) {
    const [, id, ivHex, authTagHex, ciphertext] = parts as [string, string, string, string, string];
    const secret = secrets.find((candidate) => keyId(candidate) === id);
    if (!secret) throw new Error(`this was encrypted with key ${id}, which this platform no longer holds`);
    return open(secret, ivHex, authTagHex, ciphertext);
  }

  if (parts.length !== 3) throw new Error('Invalid encrypted value format');
  const [ivHex, authTagHex, ciphertext] = parts as [string, string, string];
  if (!ivHex || !authTagHex) throw new Error('Invalid encrypted value format');

  let failure: unknown;
  for (const secret of secrets) {
    try {
      return open(secret, ivHex, authTagHex, ciphertext);
    } catch (err) {
      failure = err;
    }
  }
  throw failure;
}

export function needsReencryption(encrypted: string, key: SecretKey): boolean {
  if (LEGACY.test(encrypted)) return true;
  return VERSIONED.test(encrypted) && encrypted.split(':')[1] !== keyId(ringOf(key).current);
}

export function maskSecret(value: string, prefixLen = 4, suffixLen = 4): string {
  if (value.length <= prefixLen + suffixLen) {
    return '****';
  }
  const prefix = value.slice(0, prefixLen);
  const suffix = value.slice(-suffixLen);
  return `${prefix}****${suffix}`;
}
