/**
 * AES-256-GCM encryption/decryption utilities for credential storage.
 *
 * Uses Node's native crypto module — zero external dependencies.
 * The master key is derived from JWT_SECRET via scrypt with a fixed
 * domain-separation salt so it doesn't collide with password hashing.
 */
import crypto from 'crypto';

const CREDENTIAL_SALT = 'ianthe-credential-encryption-v1';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 256-bit encryption key from the master secret.
 * Uses a fixed domain-separation salt so the derived key is
 * deterministic for the same JWT_SECRET but distinct from password hashes.
 */
function deriveKey(masterSecret: string): Buffer {
  return crypto.scryptSync(masterSecret, CREDENTIAL_SALT, KEY_LENGTH);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a colon-separated string: `iv:authTag:ciphertext` (all hex).
 */
export function encryptValue(plaintext: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a value previously encrypted with `encryptValue`.
 * Throws if the ciphertext has been tampered with or the key is wrong.
 */
export function decryptValue(encrypted: string, masterKey: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }

  const [ivHex, authTagHex, ciphertext] = parts;
  if (!ivHex || !authTagHex || ciphertext === undefined) {
    throw new Error('Invalid encrypted value format');
  }

  const key = deriveKey(masterKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Mask a sensitive string for display purposes.
 * Shows the first `prefixLen` and last `suffixLen` characters,
 * replacing the middle with asterisks.
 */
export function maskSecret(value: string, prefixLen = 4, suffixLen = 4): string {
  if (value.length <= prefixLen + suffixLen) {
    return '****';
  }
  const prefix = value.slice(0, prefixLen);
  const suffix = value.slice(-suffixLen);
  return `${prefix}****${suffix}`;
}
