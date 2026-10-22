import { describe, it, expect } from 'vitest';
import { giteaUsernameFor, sanitiseRepoName, MAX_GITEA_USERNAME } from './projects.js';

describe('giteaUsernameFor', () => {
  it('is deterministic, so the account can be found again without a stored mapping', () => {
    const id = '3f2a1b4c-5d6e-7f80-9012-3456789abcde';
    expect(giteaUsernameFor(id)).toBe(giteaUsernameFor(id));
  });

  it('fits inside Gitea\'s 40-character username limit', () => {
    const name = giteaUsernameFor('3f2a1b4c-5d6e-7f80-9012-3456789abcde');
    expect(name.length).toBeLessThanOrEqual(MAX_GITEA_USERNAME);
    expect(name).toMatch(/^koala-[a-z0-9]+$/);
  });

  it('gives different users different accounts', () => {
    expect(giteaUsernameFor('user-a')).not.toBe(giteaUsernameFor('user-b'));
  });

  it('refuses an empty owner rather than inventing an account', () => {
    expect(() => giteaUsernameFor('')).toThrow();
    expect(() => giteaUsernameFor('///')).toThrow();
  });
});

describe('sanitiseRepoName', () => {
  it('turns what people type into what Gitea accepts', () => {
    expect(sanitiseRepoName('  My Invoice Parser!  ')).toBe('my-invoice-parser');
  });

  it('strips leading and trailing punctuation Gitea rejects', () => {
    expect(sanitiseRepoName('.hidden.')).toBe('hidden');
    expect(sanitiseRepoName('---weird---')).toBe('weird');
  });

  it('keeps characters Gitea allows', () => {
    expect(sanitiseRepoName('my_app.v2-final')).toBe('my_app.v2-final');
  });

  it('refuses a name with nothing usable, instead of creating a repo with a guessed name', () => {
    expect(() => sanitiseRepoName('!!!')).toThrow();
    expect(() => sanitiseRepoName('')).toThrow();
  });

  it('cannot be used to escape into another path', () => {
    expect(sanitiseRepoName('../../etc/passwd')).not.toContain('/');
    expect(sanitiseRepoName('../../etc/passwd')).not.toContain('..');
  });
});
