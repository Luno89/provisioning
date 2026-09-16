import { describe, it, expect } from 'vitest';
import { scopedPath, ScopeError } from './scope.js';

describe('scopedPath', () => {
  it('keeps a relative path inside the scope root', () => {
    expect(scopedPath({ path: 'apps/web' }, 'src/index.ts')).toBe('apps/web/src/index.ts');
  });

  it('prefers a worktree over the plain path so fan-out children stay apart', () => {
    expect(scopedPath({ path: 'apps/web', worktree: '.worktrees/child-1' }, 'src/index.ts'))
      .toBe('.worktrees/child-1/src/index.ts');
  });

  it('strips a leading slash rather than treating it as the real root', () => {
    expect(scopedPath({ path: 'apps/web' }, '/etc/passwd')).toBe('apps/web/etc/passwd');
  });

  it('refuses to climb out of the scope', () => {
    expect(() => scopedPath({ path: 'apps/web' }, '../../etc/passwd')).toThrow(ScopeError);
    expect(() => scopedPath({ path: 'apps/web' }, 'src/../../../secrets')).toThrow(ScopeError);
  });

  it('refuses to climb above the working directory when there is no scope', () => {
    expect(() => scopedPath(undefined, '../outside')).toThrow(ScopeError);
    expect(scopedPath(undefined, 'src/index.ts')).toBe('src/index.ts');
  });

  it('allows the scope root itself', () => {
    expect(scopedPath({ path: 'apps/web' }, '.')).toBe('apps/web');
  });
});