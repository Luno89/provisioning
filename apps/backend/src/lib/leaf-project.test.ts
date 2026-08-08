/**
 * The case that matters is the second leaf of a request: it has to land in the FIRST leaf's
 * repository. Anywhere else and the hand-off is between two unrelated repos, which looks like it
 * worked and shares nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveLeafProject, autoRepoNameFor } from './leaf-project.js';
import type { Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'branch-abc-123', title: 't', body: '',
  column: 'todo', status: 'pending', depth: 0, blocking: true,
  createdAt: '', updatedAt: '', ...over,
} as Leaf);

const deps = (projects: any[] = [], over: Record<string, unknown> = {}) => ({
  db: { getProjects: vi.fn(async () => projects), saveProject: vi.fn(async (p: any) => { projects.push(p); }) },
  ensureAccount: vi.fn(async () => ({ username: 'koala-u1' })),
  repoExists: vi.fn(async () => false),
  createRepo: vi.fn(async () => undefined),
  newId: () => 'new-id',
  ...over,
} as any);

describe('choosing where a leaf works', () => {
  it('uses the project it was given', async () => {
    const chosen = { id: 'p1', ownerId: 'u1', giteaRepo: 'chosen', giteaOwner: 'o', name: 'n', appType: 'generic', createdAt: '' };
    const d = deps([chosen]);

    expect((await resolveLeafProject(d, leaf({ projectId: 'p1' }))).id).toBe('p1');
    expect(d.createRepo).not.toHaveBeenCalled();
  });

  it('makes one for the request when none was chosen', async () => {
    // The default path used to be the losing one: no project meant the pod was the only copy.
    const d = deps();
    const project = await resolveLeafProject(d, leaf());

    expect(project.giteaRepo).toBe(autoRepoNameFor('branch-abc-123'));
    expect(d.createRepo).toHaveBeenCalledWith('koala-u1', project.giteaRepo);
    expect(d.db.saveProject).toHaveBeenCalled();
  });

  it('puts every leaf of one request in the SAME repository', async () => {
    const shared: any[] = [];
    const d = deps(shared);

    const first = await resolveLeafProject(d, leaf({ id: 'l1' }));
    const second = await resolveLeafProject(d, leaf({ id: 'l2' }));

    // The hand-off depends entirely on this. Two repos would share nothing while looking fine.
    expect(second.id).toBe(first.id);
    expect(d.createRepo).toHaveBeenCalledTimes(1);
  });

  it('gives different requests different repositories', async () => {
    const shared: any[] = [];
    const d = deps(shared);

    const a = await resolveLeafProject(d, leaf({ branchId: 'branch-aaa' }));
    const b = await resolveLeafProject(d, leaf({ branchId: 'branch-bbb' }));

    expect(a.giteaRepo).not.toBe(b.giteaRepo);
  });

  it('does not hand a leaf another owner\'s project', async () => {
    // projectId arrives on a leaf that a model proposed, so it is untrusted like any other id.
    const theirs = { id: 'p1', ownerId: 'someone-else', giteaRepo: 'theirs', giteaOwner: 'o', name: 'n', appType: 'generic', createdAt: '' };
    const d = deps([theirs]);

    const project = await resolveLeafProject(d, leaf({ projectId: 'p1' }));
    expect(project.id).not.toBe('p1');
    expect(project.ownerId).toBe('u1');
  });

  it('falls through to a fresh project when the id is stale', async () => {
    // Losing the work over a dangling reference is worse than working somewhere else.
    const d = deps();
    await expect(resolveLeafProject(d, leaf({ projectId: 'deleted' }))).resolves.toMatchObject({ ownerId: 'u1' });
  });

  it('produces a repository name Gitea will accept', async () => {
    expect(autoRepoNameFor('AB-CD/ef!12345')).toMatch(/^koala-request-[a-z0-9]+$/);
  });
});

describe('two leaves of one request racing', () => {
  it('adopts a repository that already exists instead of creating it again', async () => {
    // Observed live: the loser of the race got `duplicate key value violates unique constraint`
    // back as a 500 and ended up with no repository at all.
    const d = deps([], { repoExists: vi.fn(async () => true) });

    await expect(resolveLeafProject(d, leaf())).resolves.toMatchObject({ ownerId: 'u1' });
    expect(d.createRepo).not.toHaveBeenCalled();
  });

  it('survives losing the create race outright', async () => {
    // Exists check says no, then the other leaf creates it before we do.
    let exists = false;
    const d = deps([], {
      repoExists: vi.fn(async () => exists),
      createRepo: vi.fn(async () => { exists = true; throw new Error('duplicate key value violates unique constraint'); }),
    });

    await expect(resolveLeafProject(d, leaf())).resolves.toMatchObject({ ownerId: 'u1' });
  });

  it('still reports a create failure that left no repository', async () => {
    // A real failure — no permission, Gitea down — must not be swallowed into a project row
    // pointing at a repository that does not exist.
    const d = deps([], { createRepo: vi.fn(async () => { throw new Error('HTTP 403'); }) });
    await expect(resolveLeafProject(d, leaf())).rejects.toThrow('HTTP 403');
  });

  it('does not write a second project row for the same repository', async () => {
    // The racing leaf may save the row while this one is creating the repo. Two rows would split
    // one request's leaves across two project ids, which is exactly no hand-off.
    const projects: any[] = [];
    const d = deps(projects, {
      createRepo: vi.fn(async () => {
        projects.push({ id: 'theirs', ownerId: 'u1', giteaRepo: autoRepoNameFor('branch-abc-123'), giteaOwner: 'koala-u1', name: 'n', appType: 'generic', createdAt: '' });
      }),
    });

    expect((await resolveLeafProject(d, leaf())).id).toBe('theirs');
    expect(d.db.saveProject).not.toHaveBeenCalled();
  });
});
