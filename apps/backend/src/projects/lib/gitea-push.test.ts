import { describe, expect, it } from 'vitest';
import { giteaPushOf, pushToBuild } from './gitea-push.js';

const push = (ref: string, repository: unknown = { default_branch: 'trunk' }) => ({
  ref, after: 'abc123', repository,
  commits: [{ added: ['a.txt', 7], modified: ['b.txt'], removed: [] }, 'not a commit'],
});

describe('only the default branch builds', () => {
  it('builds a push to the branch the repository names as its default', () => {
    expect(pushToBuild(push('refs/heads/trunk'))).toEqual({ build: {
      ref: 'trunk', after: 'abc123', defaultBranch: 'trunk',
      commits: [{ added: ['a.txt'], modified: ['b.txt'], removed: [] }, { added: [], modified: [], removed: [] }],
    } });
  });

  it('takes the default branch from the payload rather than assuming main', () => {
    expect(pushToBuild(push('refs/heads/main'))).toEqual({ ignored: 'not the default branch (main != trunk)' });
  });

  it('falls back to main only when the payload names no default branch', () => {
    expect(pushToBuild(push('refs/heads/main', {}))).toMatchObject({ build: { ref: 'main', defaultBranch: 'main' } });
    expect(pushToBuild(push('refs/heads/feature', null))).toEqual({ ignored: 'not the default branch (feature != main)' });
  });

  it('ignores anything that is not a push', () => {
    expect(pushToBuild({ action: 'opened' })).toEqual({ ignored: 'not a push event' });
    expect(pushToBuild({ ref: 'refs/heads/trunk', after: '' })).toEqual({ ignored: 'not a push event' });
    expect(giteaPushOf('text')).toBeUndefined();
  });
});
