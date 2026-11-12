import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ProjectMetadata } from '../../platform/index.js';
import { releaseDecider, type ReleaseDeciderDeps } from './release-decider.js';

const project = { id: 'p1', name: 'Books', ownerId: 'bo', giteaOwner: 'acme', giteaRepo: 'books' } as ProjectMetadata;

const deciderWith = (releaseWhen: string[] | undefined, changed: ReleaseDeciderDeps['changed']) => {
  const trees = mock<ReleaseDeciderDeps['trees']>();
  trees.getTrees.mockResolvedValue([{ id: 't1', ownerId: 'bo', type: 'books-app', projectIds: ['p1'] }]);
  trees.getTreeTypes.mockResolvedValue([{ id: 'books-app', ownerId: 'bo', ...(releaseWhen ? { releaseWhen } : {}) }] as never);
  return releaseDecider({ trees, changed });
};

describe('deciding whether a build is released', () => {
  it('asks what changed only when the project\'s tree type names what its app is built from', async () => {
    const changed = vi.fn(async () => ['README.md']);
    expect(await deciderWith(undefined, changed)(project, 'aaaaaaaa1', 'bbbbbbbb2')).toEqual({ release: true });
    expect(changed).not.toHaveBeenCalled();
    expect(await deciderWith(['app/**'], changed)(project, 'aaaaaaaa1', 'bbbbbbbb2')).toEqual({ release: false, reason: 'only README.md changed since aaaaaaaa, none of which the app is built from' });
  });

  it('releases a project with no repository, and does not release one whose changes cannot be read, saying why', async () => {
    expect(await deciderWith(['app/**'], vi.fn())({ id: 'p1', name: 'Books', ownerId: 'bo' } as ProjectMetadata, 'aaaaaaaa1', 'b')).toEqual({ release: true });
    const unread = await deciderWith(['app/**'], async () => { throw new Error('Gitea answered 500'); })(project, 'aaaaaaaa1', 'b');
    expect(unread).toEqual({ release: false, reason: 'what changed since aaaaaaaa could not be read, so the build is not released: Gitea answered 500' });
  });
});
