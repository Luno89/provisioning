import { createHmac, timingSafeEqual } from 'node:crypto';
import { ringOf } from '../../platform/lib/crypto.js';
import type { SecretKey } from '../../platform/index.js';

const hashWith = (key: string, id: string, code: string): string => createHmac('sha256', key).update(`${id}:${code.trim()}`).digest('hex');

export const codeHash = (key: SecretKey, id: string, code: string): string => hashWith(ringOf(key).current, id, code);

export function sameCode(key: SecretKey, held: { id: string; codeHash: string }, given: string): boolean {
  const expected = Buffer.from(held.codeHash, 'hex');
  const ring = ringOf(key);
  return [ring.current, ...(ring.previous ?? [])].some((one) => {
    const offered = Buffer.from(hashWith(one, held.id, given), 'hex');
    return expected.length === offered.length && timingSafeEqual(expected, offered);
  });
}
