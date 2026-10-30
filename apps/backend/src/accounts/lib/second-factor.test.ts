import { describe, expect, it } from 'vitest';
import { confirmWith, passwordChangeNeeds, proofFrom, sameTwoFactorCode, twoFactorCodeHash, twoFactorCodeId, twoFactorExpiry, twoFactorLive } from './second-factor.js';

describe('a two-factor code', () => {
  it('is held only as a hash bound to its account and purpose, and matches only itself', () => {
    const id = twoFactorCodeId('u1', 'confirm');
    expect(id).toBe('confirm:u1');
    const held = { id, codeHash: twoFactorCodeHash(id, '123456') };
    expect(held.codeHash).not.toContain('123456');
    expect(sameTwoFactorCode(held, ' 123456 ')).toBe(true);
    expect(sameTwoFactorCode(held, '654321')).toBe(false);
    expect(sameTwoFactorCode({ id: twoFactorCodeId('u1', 'sign-in'), codeHash: held.codeHash }, '123456')).toBe(false);
  });

  it('works for five minutes', () => {
    const expiresAt = twoFactorExpiry(1_000);
    expect(twoFactorLive({ expiresAt }, 1_000 + 5 * 60_000 - 1)).toBe(true);
    expect(twoFactorLive({ expiresAt }, 1_000 + 5 * 60_000)).toBe(false);
    expect(twoFactorLive(undefined, 0)).toBe(false);
  });
});

describe('what a risky change asks for', () => {
  it('asks a two-factor code when two-factor is on, the password when it is off, and an emailed code from an account with no password', () => {
    expect(confirmWith({ twoFactorEnabled: true, passwordHash: 'h' })).toBe('two-factor');
    expect(confirmWith({ twoFactorEnabled: false, passwordHash: 'h' })).toBe('password');
    expect(confirmWith({ twoFactorEnabled: false })).toBe('email-code');
  });

  it('asks the current password to change it, and a code too with two-factor on or no password to give', () => {
    expect(passwordChangeNeeds({ passwordHash: 'h' })).toEqual({ current: true, code: false });
    expect(passwordChangeNeeds({ passwordHash: 'h', twoFactorEnabled: true })).toEqual({ current: true, code: true });
    expect(passwordChangeNeeds({})).toEqual({ current: false, code: true });
  });

  it('reads only a password and a code from what was sent', () => {
    expect(proofFrom({ password: 'pw', code: ' 123456 ', other: 1 })).toEqual({ password: 'pw', code: '123456' });
    expect(proofFrom({ password: '', code: 7 })).toEqual({});
    expect(proofFrom(undefined)).toEqual({});
  });
});
