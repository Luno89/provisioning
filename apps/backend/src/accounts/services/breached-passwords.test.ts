import { describe, expect, it } from 'vitest';
import { loadBreachedPasswords } from './breached-passwords.js';
import { passwordProblem } from '../lib/passwords.js';

describe('the list of leaked passwords shipped with Koala', () => {
  const breached = loadBreachedPasswords();

  it('holds well-known leaked passwords of twelve characters or more, in any case', () => {
    for (const leaked of ['password1234', 'qwertyuiop123', 'iloveyou1234', '123456789012', 'PasswordPassword']) expect(breached.has(leaked), leaked).toBe(true);
    expect(passwordProblem('Password1234', breached)).toContain('leaked');
  });

  it('lets a password nobody has leaked through', () => {
    expect(breached.has('a-koala-climbs-the-gum-tree-at-dawn')).toBe(false);
    expect(passwordProblem('a-koala-climbs-the-gum-tree-at-dawn', breached)).toBeUndefined();
  });
});
