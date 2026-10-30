import { describe, expect, it } from 'vitest';
import { codeHandedOut } from './sign-up.js';

describe('a sign-up code handed back by the stack under test', () => {
  it('is taken from a dev stack, which sends no email', () => {
    expect(codeHandedOut({ production: false }, '123456', 'a code')).toBe('123456');
    expect(codeHandedOut({ production: false }, undefined, 'a code')).toBeUndefined();
  });

  it('fails the suite when a production backend hands one back, which it must only email', () => {
    expect(() => codeHandedOut({ production: true, mailpitApi: 'http://127.0.0.1:8025' }, '123456', 'ann\'s sign-up code')).toThrow('a production backend handed back ann\'s sign-up code (devCode) instead of only emailing it');
    expect(codeHandedOut({ production: true, mailpitApi: 'http://127.0.0.1:8025' }, undefined, 'a code')).toBeUndefined();
  });
});
