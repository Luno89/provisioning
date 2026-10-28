import { describe, it, expect } from 'vitest';
import { emailProblem, normalEmail, sameSignUpCode, signUpCodeHash, signUpExpiry, signUpLive, SIGN_UP_MINUTES } from './sign-up.js';

describe('signing up', () => {
  it('takes an email trimmed and lowercased, and refuses what is not one', () => {
    expect(normalEmail('  Ann@Example.COM ')).toBe('ann@example.com');
    expect(normalEmail(42)).toBe('');
    for (const good of ['ann@example.com', 'a.b+c@mail.example.co.uk']) expect(emailProblem(good), good).toBeUndefined();
    for (const bad of ['', 'ann', 'ann@', '@example.com', 'ann@example', 'a@b@example.com', 'an n@example.com', 'ann@.example.com', 'ann@example.com.', `${'a'.repeat(245)}@example.com`]) {
      expect(emailProblem(bad), bad).toBe('That is not an email address; check it and try again');
    }
  });

  it('keeps only a hash of the code, bound to its sign-up, and compares it whole', () => {
    const hash = signUpCodeHash('pending-1', '123456');
    expect(hash).not.toContain('123456');
    expect(hash).not.toBe(signUpCodeHash('pending-2', '123456'));
    expect(sameSignUpCode({ id: 'pending-1', codeHash: hash }, ' 123456 ')).toBe(true);
    expect(sameSignUpCode({ id: 'pending-1', codeHash: hash }, '123457')).toBe(false);
    expect(sameSignUpCode({ id: 'pending-2', codeHash: hash }, '123456')).toBe(false);
  });

  it('lasts half an hour', () => {
    const now = new Date('2026-10-28T10:00:00.000Z');
    const until = signUpExpiry(now);
    expect(until.getTime() - now.getTime()).toBe(SIGN_UP_MINUTES * 60_000);
    expect(signUpLive({ expiresAt: until }, now)).toBe(true);
    expect(signUpLive({ expiresAt: until }, until)).toBe(false);
    expect(signUpLive(undefined, now)).toBe(false);
  });
});
