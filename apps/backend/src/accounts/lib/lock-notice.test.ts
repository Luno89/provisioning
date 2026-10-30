import { describe, expect, it } from 'vitest';
import { LOCKED_MINUTES, lockNotice } from './lock-notice.js';

describe('what a person is told when wrong passwords lock their account', () => {
  it('says how many tries, from where, for how long, and that they may want to change their password', () => {
    const told = lockNotice('203.0.113.7');
    expect(LOCKED_MINUTES).toBe(15);
    for (const text of [told.mail.text, told.push.body]) {
      expect(text).toContain('tried your Koala password 10 times from 203.0.113.7');
      expect(text).toContain('locked to other browsers for 15 minutes');
      expect(text).toContain('you may want to change your password');
    }
    expect(told.push.tag).toBe('account-locked');
  });

  it('says so when the address is not known', () => {
    expect(lockNotice(undefined).mail.text).toContain('from an address we could not tell');
  });
});
