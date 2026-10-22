import { describe, it, expect } from 'vitest';
import { isSafeRepoDir, isSafeRepoFilePath } from './project-file-paths.js';

describe('isSafeRepoDir', () => {
  it('accepts an empty path, meaning the repo root', () => {
    expect(isSafeRepoDir('')).toBe(true);
  });

  it('accepts an ordinary nested path', () => {
    expect(isSafeRepoDir('src/components')).toBe(true);
  });

  it('refuses an absolute path', () => {
    expect(isSafeRepoDir('/etc')).toBe(false);
  });

  it('refuses a path that climbs out of the repo', () => {
    expect(isSafeRepoDir('src/../../etc')).toBe(false);
    expect(isSafeRepoDir('..')).toBe(false);
  });
});

describe('isSafeRepoFilePath', () => {
  it('accepts an ordinary file path', () => {
    expect(isSafeRepoFilePath('src/index.ts')).toBe(true);
  });

  it('refuses an empty path — a file operation always needs one', () => {
    expect(isSafeRepoFilePath('')).toBe(false);
    expect(isSafeRepoFilePath('   ')).toBe(false);
  });

  it('refuses an absolute or escaping path', () => {
    expect(isSafeRepoFilePath('/etc/passwd')).toBe(false);
    expect(isSafeRepoFilePath('../outside.md')).toBe(false);
  });
});
