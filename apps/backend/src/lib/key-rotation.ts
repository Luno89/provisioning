import { decryptValue, encryptValue, looksEncrypted, needsReencryption, type Keyring } from './crypto.js';

export interface Reencrypted<T> {
  value: T;
  rewritten: string[];
  unreadable: string[];
}

export function reencrypt<T>(value: T, ring: Keyring, at = ''): Reencrypted<T> {
  const rewritten: string[] = [];
  const unreadable: string[] = [];

  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === 'string') {
      if (!looksEncrypted(node) || !needsReencryption(node, ring)) return node;
      try {
        const plain = decryptValue(node, ring);
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
