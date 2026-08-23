import { describe, it, expect } from 'vitest';
import { runLeafTool, type LeafToolContext } from './leaf-tool-runner.js';
import { MemoryDB } from './memory-db.js';
import { resolveLeafProject, autoRepoNameFor } from './leaf-project.js';
import { withProject, primaryProjectId } from './trees.js';

/**
 * Every leaf of one request landing in ONE repository.
 *
 * ── THE RUN THIS SPLIT ──
 * A planning turn called `create_project("github-mcp")` and never called `set_leaf_project`. The
 * project attached to nothing, so each leaf resolved no project, fell through to the per-branch
 * fallback, and built in `koala-request-30b2d228` while `github-mcp` sat empty.
 *
 * It could not be recovered afterwards either: the first leaf to FINISH calls `withProject` with
 * whatever it resolved, so the fallback became the tree's primary repository permanently — and
 * every later branch of the same effort would have joined the wrong one too.
 *
 * The chain has three links and the failure was in the first, so the tests follow all three.
 */

const seeded = async () => {
  const db = new MemoryDB() as any;
  await db.saveTree({ id: 't1', ownerId: 'u1', name: 'GitHub API MCP', createdAt: 'now', updatedAt: 'now' });
  await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', createdAt: 'now', updatedAt: 'now' });
  return db;
};

const ctx = (db: any, projects: any): LeafToolContext => ({
  db, userId: 'u1', branchId: 'b1',
  webSearch: async () => ({ hits: [], unavailable: false, answeredBy: 'searxng' as const }), fetchWebPage: async () => '', projects,
});

const fakeProjects = (db: any) => ({
  register: async (ownerId: string, name: string) => {
    const project = { id: `p-${name}`, ownerId, name, giteaOwner: 'koala-u1', giteaRepo: name, createdAt: 'now' };
    await db.saveProject(project);
    return project;
  },
  listForOwner: async (ownerId: string) => (await db.getProjects()).filter((p: any) => p.ownerId === ownerId),
});

describe('link one: creating a project attaches it to the tree', () => {
  it('makes the named project the tree\'s primary repository', async () => {
    const db = await seeded();
    await runLeafTool(ctx(db, fakeProjects(db)), {
      name: 'create_project', arguments: JSON.stringify({ name: 'github-mcp' }),
    });
    const tree = (await db.getTrees()).find((t: any) => t.id === 't1');
    expect(primaryProjectId(tree)).toBe('p-github-mcp');
  });

  it('tells the model it does not need to set it per leaf', async () => {
    // Otherwise it does the second step anyway, or worse, believes it must and gives up when the
    // round trips run out.
    const db = await seeded();
    const out = JSON.parse(await runLeafTool(ctx(db, fakeProjects(db)), {
      name: 'create_project', arguments: JSON.stringify({ name: 'github-mcp' }),
    }));
    expect(out.created.id).toBe('p-github-mcp');
    expect(out.note).toMatch(/by default/);
  });

  it('does NOT hijack a tree that already has a repository', async () => {
    /**
     * `withProject` appends and keeps the first primary. A second project created mid-effort must
     * not repoint work that is already landing somewhere.
     */
    const db = await seeded();
    const first = (await db.getTrees()).find((t: any) => t.id === 't1');
    await db.saveTree(withProject(first, 'p-original'));
    await runLeafTool(ctx(db, fakeProjects(db)), {
      name: 'create_project', arguments: JSON.stringify({ name: 'second' }),
    });
    const tree = (await db.getTrees()).find((t: any) => t.id === 't1');
    expect(primaryProjectId(tree)).toBe('p-original');
    expect(tree.projectIds).toContain('p-second');
  });

  it('still creates the project when the branch has no tree', async () => {
    // A branch outside a tree is legal. Losing the project over it would be worse than not
    // attaching.
    const db = new MemoryDB() as any;
    await db.saveBranch({ id: 'b1', ownerId: 'u1', createdAt: 'now', updatedAt: 'now' });
    const out = JSON.parse(await runLeafTool(ctx(db, fakeProjects(db)), {
      name: 'create_project', arguments: JSON.stringify({ name: 'loose' }),
    }));
    expect(out.created.id).toBe('p-loose');
    expect(out.note).toBeUndefined();
  });

  it('will not attach to another user\'s tree', async () => {
    const db = await seeded();
    const stolen = ctx(db, fakeProjects(db));
    await runLeafTool({ ...stolen, userId: 'intruder' }, {
      name: 'create_project', arguments: JSON.stringify({ name: 'theirs' }),
    });
    const tree = (await db.getTrees()).find((t: any) => t.id === 't1');
    expect(tree.projectIds ?? []).toEqual([]);
  });
});

describe('pointing a leaf at an existing service', () => {
  /**
   * The path the planner should have taken: it found `github-mcp`, was given its projectId by
   * list_mcp_servers, and could point the verify leaf at it. Without the tree learning, every OTHER
   * leaf on the branch would still fall through to a per-branch repository.
   */
  const point = async (db: any, treeHasProject: boolean) => {
    if (treeHasProject) {
      const t = (await db.getTrees()).find((x: any) => x.id === 't1');
      await db.saveTree(withProject(t, 'p-existing'));
    }
    await db.saveProject({ id: 'p-github', ownerId: 'u1', name: 'github-mcp', giteaOwner: 'koala-u1', giteaRepo: 'github-mcp', createdAt: 'now' });
    await db.saveLeaf({ id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'Verify it', status: 'proposed', createdAt: 'now', updatedAt: 'now' });
    return JSON.parse(await runLeafTool(ctx(db, fakeProjects(db)), {
      name: 'set_leaf_project', arguments: JSON.stringify({ id: 'l1', projectId: 'p-github' }),
    }));
  };

  it('makes it the branch\'s repository when the tree has none', async () => {
    const db = await seeded();
    const out = await point(db, false);
    expect(out.updated.projectId).toBe('p-github');
    expect(primaryProjectId((await db.getTrees()).find((t: any) => t.id === 't1'))).toBe('p-github');
    expect(out.note).toMatch(/Other leaves on this branch/);
  });

  it('does NOT repoint a tree whose work is already landing somewhere', async () => {
    // A per-leaf exception must stay per-leaf.
    const db = await seeded();
    const out = await point(db, true);
    expect(out.updated.projectId).toBe('p-github');
    expect(primaryProjectId((await db.getTrees()).find((t: any) => t.id === 't1'))).toBe('p-existing');
    expect(out.note).toBeUndefined();
  });
});

describe('link two: a leaf resolves the tree\'s project', () => {
  const deps = (db: any, treeProjectId?: string) => ({
    ...(treeProjectId ? { treeProjectId } : {}),
    db,
    ensureAccount: async () => ({ username: 'koala-u1' }),
    repoExists: async () => false,
    createRepo: async () => undefined,
    newId: () => 'p-auto',
  });

  it('lands in the attached project instead of a per-branch fallback', async () => {
    const db = await seeded();
    await db.saveProject({ id: 'p-github-mcp', ownerId: 'u1', name: 'github-mcp', giteaOwner: 'koala-u1', giteaRepo: 'github-mcp', createdAt: 'now' });
    const got = await resolveLeafProject(
      deps(db, 'p-github-mcp') as any,
      { id: 'l1', ownerId: 'u1', branchId: 'b1' } as any,
    );
    expect(got.id).toBe('p-github-mcp');
    expect(got.giteaRepo).toBe('github-mcp');
  });

  it('falls back to the per-branch repository when nothing is attached', async () => {
    // The observed run. Correct behaviour on its own — it only became wrong because link one
    // never fired.
    const db = await seeded();
    const got = await resolveLeafProject(deps(db) as any, { id: 'l1', ownerId: 'u1', branchId: 'b1' } as any);
    expect(got.giteaRepo).toBe(autoRepoNameFor('b1'));
  });

  it('lets an explicit leaf project win over the tree\'s', async () => {
    // set_leaf_project is still the override, for a leaf that genuinely belongs elsewhere.
    const db = await seeded();
    await db.saveProject({ id: 'p-other', ownerId: 'u1', name: 'other', giteaOwner: 'koala-u1', giteaRepo: 'other', createdAt: 'now' });
    await db.saveProject({ id: 'p-tree', ownerId: 'u1', name: 'tree', giteaOwner: 'koala-u1', giteaRepo: 'tree', createdAt: 'now' });
    const got = await resolveLeafProject(
      deps(db, 'p-tree') as any,
      { id: 'l1', ownerId: 'u1', branchId: 'b1', projectId: 'p-other' } as any,
    );
    expect(got.id).toBe('p-other');
  });
});

describe('link three: every leaf of a request agrees', () => {
  it('gives concurrent leaves of one branch the same repository', async () => {
    /**
     * The property the whole chain exists for. Leaves run in parallel, and two repositories for one
     * request means leaf 2 cannot build on leaf 1.
     */
    const db = await seeded();
    await db.saveProject({ id: 'p-github-mcp', ownerId: 'u1', name: 'github-mcp', giteaOwner: 'koala-u1', giteaRepo: 'github-mcp', createdAt: 'now' });
    const deps = {
      treeProjectId: 'p-github-mcp', db,
      ensureAccount: async () => ({ username: 'koala-u1' }),
      repoExists: async () => false, createRepo: async () => undefined, newId: () => 'p-auto',
    };
    const got = await Promise.all(
      ['l1', 'l2', 'l3', 'l4'].map((id) =>
        resolveLeafProject(deps as any, { id, ownerId: 'u1', branchId: 'b1' } as any)),
    );
    expect(new Set(got.map((g) => g.id)).size).toBe(1);
    expect(got[0]!.giteaRepo).toBe('github-mcp');
  });

  it('re-attaching the same project is a no-op, so the executor cannot undo it', async () => {
    // The executor calls withProject with whatever it resolved. Once link one has run, that is the
    // same id — and appending it twice would be the bug that made the fallback primary.
    const db = await seeded();
    const tree = (await db.getTrees()).find((t: any) => t.id === 't1');
    const once = withProject(tree, 'p-github-mcp');
    expect(withProject(once, 'p-github-mcp').projectIds).toEqual(['p-github-mcp']);
  });
});
