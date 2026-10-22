import { describe, expect, it } from 'vitest';
import { nameProblem, suggestedName } from './instance-names.js';

describe('instance names', () => {
  it('takes lowercase letters and digits starting with a letter', () => {
    expect(nameProblem('luno')).toBeNull();
    expect(nameProblem('shop42')).toBeNull();
    expect(nameProblem('ab')).toMatch(/3 to 20/);
    expect(nameProblem('4ever')).toMatch(/starting with a letter/);
    expect(nameProblem('Luno')).toMatch(/lowercase/);
    expect(nameProblem('a'.repeat(21))).toMatch(/3 to 20/);
  });

  it('refuses a dash, saying why', () => {
    expect(nameProblem('luno-x')).toMatch(/<app>-<name>/);
  });

  it('refuses names the platform keeps, and root\'s own sites', () => {
    expect(nameProblem('mesh')).toMatch(/kept for the platform/);
    expect(nameProblem('studio', ['studio'])).toMatch(/kept for the platform/);
  });

  it('suggests a name from the email that passes the rules', () => {
    expect(suggestedName('lunosnyper@gmail.com')).toBe('lunosnyper');
    expect(suggestedName('j.doe-smith@x.io')).toBe('jdoesmith');
    expect(suggestedName('42@x.io')).toBe('home');
    expect(suggestedName('admin@x.io')).toBe('adminhome');
    expect(nameProblem(suggestedName('ab@x.io'))).toBeNull();
  });
});
