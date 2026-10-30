import { describe, expect, it } from 'vitest';
import { breachedFrom, PASSWORD_LONGEST, passwordProblem } from './passwords.js';

const breached = breachedFrom('correcthorsebattery\npassword1234\n');

describe('what a new password has to be', () => {
  it('is at least twelve characters, counted as characters a person types', () => {
    expect(passwordProblem('short-pass1', breached)).toBe('Use at least 12 characters for your password');
    expect(passwordProblem('long-enough-1', breached)).toBeUndefined();
    expect(passwordProblem('ééééééééééé', breached)).toBe('Use at least 12 characters for your password');
  });

  it('is a string, and not an absurd length', () => {
    expect(passwordProblem(undefined, breached)).toBe('Choose a password');
    expect(passwordProblem(12345678901234, breached)).toBe('Choose a password');
    expect(passwordProblem('x'.repeat(PASSWORD_LONGEST + 1), breached)).toContain('at most');
  });

  it('is not on the list of leaked passwords, whatever its case', () => {
    expect(passwordProblem('Password1234', breached)).toBe('That password is on lists of passwords leaked from other sites; choose another');
    expect(passwordProblem('CorrectHorseBattery', breached)).toContain('leaked');
  });

  it('is not the account\'s own email address', () => {
    expect(passwordProblem('Ann@Example.com', breached, 'ann@example.com')).toBe('Your password cannot be your email address');
  });
});
