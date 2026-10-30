import { describe, expect, it } from 'vitest';
import { resetCodeMail, resetExpiry, resetLive, takenAddressMail } from './password-reset.js';

describe('a password reset', () => {
  it('lasts thirty minutes', () => {
    const now = new Date(10_000);
    const expiresAt = resetExpiry(now);
    expect(resetLive({ expiresAt }, new Date(10_000 + 30 * 60_000 - 1))).toBe(true);
    expect(resetLive({ expiresAt }, new Date(10_000 + 30 * 60_000))).toBe(false);
    expect(resetLive(undefined, now)).toBe(false);
  });

  it('emails its code with what resetting does, and a sign-up of a taken address tells its owner instead', () => {
    expect(resetCodeMail('123456').text).toContain('123456');
    expect(resetCodeMail('123456').text).toContain('signs you out everywhere');
    const taken = takenAddressMail('https://app.example.com');
    expect(taken.text).toContain('already has an account');
    expect(taken.text).not.toMatch(/\d{6}/);
  });
});
