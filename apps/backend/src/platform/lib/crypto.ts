import { decryptValue, encryptValue, keyId, ringOf, type Keyring, type SecretKey } from '@koala/engine-core/payloads';

export { decryptValue, encryptValue, keyId, ringOf, type Keyring, type SecretKey };

const LEGACY = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/;
const VERSIONED = /^v2:[0-9a-f]{8}:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/;

export const looksEncrypted = (value: string): boolean => LEGACY.test(value) || VERSIONED.test(value);

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
