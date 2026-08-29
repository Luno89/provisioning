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
    const theirs = { id: 'p1', ownerId: 'someone-else', giteaRepo: 'theirs', giteaOwner: 'o', name: 'n', appType: 'generic', createdAt: '' };
    const d = deps([theirs]);

    const project = await resolveLeafProject(d, leaf({ projectId: 'p1' }));
    expect(project.id).not.toBe('p1');
    expect(project.ownerId).toBe('u1');
  });

  it('falls through to a fresh project when the id is stale', async () => {
    const d = deps();
    await expect(resolveLeafProject(d, leaf({ projectId: 'deleted' }))).resolves.toMatchObject({ ownerId: 'u1' });
  });

  it('produces a repository name Gitea will accept', async () => {
    expect(autoRepoNameFor('AB-CD/ef!12345')).toMatch(/^koala-request-[a-z0-9]+$/);
  });
});

describe('two leaves of one request racing', () => {
  it('adopts a repository that already exists instead of creating it again', async () => {
    const d = deps([], { repoExists: vi.fn(async () => true) });

    await expect(resolveLeafProject(d, leaf())).resolves.toMatchObject({ ownerId: 'u1' });
    expect(d.createRepo).not.toHaveBeenCalled();
  });

  it('survives losing the create race outright', async () => {
    let exists = false;
    const d = deps([], {
      repoExists: vi.fn(async () => exists),
      createRepo: vi.fn(async () => { exists = true; throw new Error('duplicate key value violates unique constraint'); }),
    });

    await expect(resolveLeafProject(d, leaf())).resolves.toMatchObject({ ownerId: 'u1' });
  });

  it('still reports a create failure that left no repository', async () => {
    const d = deps([], { createRepo: vi.fn(async () => { throw new Error('HTTP 403'); }) });
    await expect(resolveLeafProject(d, leaf())).rejects.toThrow('HTTP 403');
  });

  it('does not write a second project row for the same repository', async () => {
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

describe('two leaves of one request racing for the repository', () => {
  const duplicateKey = () => Object.assign(
    new Error('E11000 duplicate key error collection: provisioning.projects index: giteaOwner_1_giteaRepo_1'),
    { code: 11000 },
  );

  it('returns the winner rather than failing the loser', async () => {
    const repo = autoRepoNameFor(leaf().branchId);
    const winner = {
      id: 'winner', ownerId: 'u1', giteaOwner: 'koala-u1', giteaRepo: repo,
      name: repo, appType: 'generic', createdAt: '',
    };
    let written = false;
    const d = deps([], {
      db: {
        getProjects: vi.fn(async () => (written ? [winner] : [])),
        saveProject: vi.fn(async () => { written = true; throw duplicateKey(); }),
      },
    });

    const got = await resolveLeafProject(d, leaf());

    expect(got.id).toBe('winner');
    expect(got.giteaRepo).toBe(repo);
  });

  it('still throws when the write failed for some other reason', async () => {
    const d = deps([], {
      db: {
        getProjects: vi.fn(async () => []),
        saveProject: vi.fn(async () => { throw new Error('connection reset'); }),
      },
    });

    await expect(resolveLeafProject(d, leaf())).rejects.toThrow(/connection reset/);
  });
});
