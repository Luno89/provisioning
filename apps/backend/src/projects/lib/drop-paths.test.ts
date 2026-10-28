import { describe, expect, it } from 'vitest';
import { blockedDropPath, dropPathQueries } from './drop-paths.js';

describe('where a dropped file may go in a commit', () => {
  it('asks about each file and every folder above it', () => {
    expect(dropPathQueries('c1', ['a/b/c.txt', 'd.txt'])).toBe('c1:a\nc1:a/b\nc1:a/b/c.txt\nc1:d.txt\n');
  });

  it('finds a file landing on a folder, or under a file', () => {
    expect(blockedDropPath(['src'], 'abc tree 10\n')).toEqual({ path: 'src', is: 'folder', dropped: 'src' });
    expect(blockedDropPath(['a/b.txt'], 'abc blob 3\nc1:a/b.txt missing\n')).toEqual({ path: 'a', is: 'file', dropped: 'a/b.txt' });
    expect(blockedDropPath(['a/b.txt', 'c.txt'], 'abc tree 1\nabd blob 2\nc1:c.txt missing\n')).toBeUndefined();
  });
});
