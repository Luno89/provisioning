import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { codeHash, sameCode } from './codes.js';

const KEY = 'the-data-key-codes-are-kept-with';

describe('a code sent to a person', () => {
  it('is kept only as a hash bound to what it is for, and compared whole', () => {
    const held = { id: 'pending-1', codeHash: codeHash(KEY, 'pending-1', '123456') };
    expect(held.codeHash).not.toContain('123456');
    expect(sameCode(KEY, held, ' 123456 ')).toBe(true);
    expect(sameCode(KEY, held, '123457')).toBe(false);
    expect(sameCode(KEY, { ...held, id: 'pending-2' }, '123456')).toBe(false);
  });

  it('cannot be found from its hash by trying every six digits without the key', () => {
    const hash = codeHash(KEY, 'pending-1', '123456');
    expect(hash).not.toBe(createHash('sha256').update('pending-1:123456').digest('hex'));
    expect(sameCode('another-key-altogether', { id: 'pending-1', codeHash: hash }, '123456')).toBe(false);
  });

  it('still matches once the key it was kept with has become the previous one', () => {
    const held = { id: 'reset-1', codeHash: codeHash('the-old-data-key', 'reset-1', '654321') };
    expect(sameCode({ current: KEY, previous: ['the-old-data-key'] }, held, '654321')).toBe(true);
    expect(codeHash({ current: KEY, previous: ['the-old-data-key'] }, 'reset-1', '654321')).toBe(codeHash(KEY, 'reset-1', '654321'));
  });
});
