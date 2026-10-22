import { describe, expect, it } from 'vitest';
import { isShareDays, shareExpires, shareLive, SHARE_TOKEN } from './file-shares.js';

describe('a link to one file', () => {
  it('lasts a day, a week or a month, and no longer', () => {
    expect([1, 7, 30, 2, '7'].map(isShareDays)).toEqual([true, true, true, false, false]);
    expect(shareExpires('2026-10-21T10:00:00.000Z', 7)).toBe('2026-10-28T10:00:00.000Z');
    expect(shareLive({ expiresAt: '2026-10-28T10:00:00.000Z' }, '2026-10-28T09:59:59.000Z')).toBe(true);
    expect(shareLive({ expiresAt: '2026-10-28T10:00:00.000Z' }, '2026-10-28T10:00:00.000Z')).toBe(false);
  });

  it('is named by a token that cannot be guessed or forged into a path', () => {
    expect(SHARE_TOKEN.test('a'.repeat(32))).toBe(true);
    expect(SHARE_TOKEN.test('../../etc/passwd')).toBe(false);
    expect(SHARE_TOKEN.test('a'.repeat(31))).toBe(false);
  });
});
