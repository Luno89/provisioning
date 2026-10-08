import { describe, it, expect } from 'vitest';
import { conversationRepoName, conversationWorkspaceRunId, createWorkspaceRepoResolver, pathInRepo, placeArtifacts, repoForWorkspace, treeRepoName, treeWorkspaceRunId, workspaceOwnerOf } from './workspace-repos.js';

const conversation = { workspace: { runId: 'conversation-c1' } };

describe('placing what a tool made', () => {
  it('names a file written in a conversation\'s workspace by its path in that conversation\'s repository, however the tool wrote it', () => {
    expect(placeArtifacts([
      { kind: 'file', path: 'research/r1/findings.md' },
      { kind: 'file', path: '/work/research/r1/sources/a.md' },
      { kind: 'file', path: '/work/research/r1/../r1/notes.md' },
    ], conversation)).toEqual([
      { kind: 'file', workspace: 'conversation-c1', path: 'research/r1/findings.md' },
      { kind: 'file', workspace: 'conversation-c1', path: 'research/r1/sources/a.md' },
      { kind: 'file', workspace: 'conversation-c1', path: 'research/r1/notes.md' },
    ]);
  });

  it('keeps links as they are, and drops files nobody could open later', () => {
    expect(placeArtifacts([
      { kind: 'link', url: 'https://example.com', title: 'x' },
      { kind: 'file', path: 'scratch.txt' },
    ], { workspace: { runId: 'run-7' } })).toEqual([{ kind: 'link', url: 'https://example.com', title: 'x' }]);

    expect(placeArtifacts([{ kind: 'file', path: '/tmp/out.txt' }], conversation)).toEqual([]);
    expect(placeArtifacts([{ kind: 'file', path: 'a.md' }], undefined)).toEqual([]);
  });

  it('places a tree\'s files only when they are in the tree\'s repository, not in a leaf\'s worktree on its own branch', () => {
    const tree = { workspace: { runId: 'tree-t1' } };
    expect(placeArtifacts([{ kind: 'file', path: '/work/repo/PLAN.md' }], tree)).toEqual([{ kind: 'file', workspace: 'tree-t1', path: 'PLAN.md' }]);
    expect(placeArtifacts([{ kind: 'file', path: 'greet.js' }], { ...tree, scope: { worktree: 'trees/leaf-1' } })).toEqual([]);
  });
});

describe('a path inside a repository', () => {
  it('is kept inside it', () => {
    expect(pathInRepo('research/r1/findings.md')).toBe('research/r1/findings.md');
    expect(pathInRepo('/research/r1/findings.md')).toBe('research/r1/findings.md');
    expect(pathInRepo('../other-repo/secret')).toBeUndefined();
    expect(pathInRepo('research/../../x')).toBeUndefined();
    expect(pathInRepo('.git/config')).toBeUndefined();
    expect(pathInRepo('')).toBeUndefined();
  });
});

describe('whose a workspace is', () => {
  it('reads the tree or conversation from the workspace name, and its repository', () => {
    expect(workspaceOwnerOf('conversation-c1')).toEqual({ kind: 'conversation', id: 'c1' });
    expect(workspaceOwnerOf('tree-t1')).toEqual({ kind: 'tree', id: 't1' });
    expect(workspaceOwnerOf('run-7')).toBeUndefined();
    expect(repoForWorkspace('conversation-c1')?.repo).toBe('research-c1');
  });
});

describe('the repository a tree works in', () => {
  const resolve = createWorkspaceRepoResolver({
    trees: async () => [{ id: 't-project', ownerId: 'u1', projectIds: ['p1'] }, { id: 't-alone', ownerId: 'u1' }, { id: 't-bare', ownerId: 'u1', projectIds: ['p-no-repo'] }, { id: 't-theirs', ownerId: 'u1', projectIds: ['p-theirs'] }],
    projects: async () => [{ id: 'p1', name: 'Shop', giteaOwner: 'koala-u1', giteaRepo: 'shop' }, { id: 'p-no-repo', name: 'Bare' }, { id: 'p-theirs', name: 'Elsewhere', giteaOwner: 'admin', giteaRepo: 'elsewhere' }],
    accountOf: async (ownerId) => (ownerId === 'u1' ? 'koala-u1' : undefined),
  });

  it('is the project\'s repository for a tree that belongs to a project with one in the person\'s account, and the tree\'s own otherwise', async () => {
    expect(await resolve(treeWorkspaceRunId('t-project'))).toMatchObject({ repo: 'shop', path: '/work/repo' });
    expect(await resolve(treeWorkspaceRunId('t-alone'))).toMatchObject({ repo: treeRepoName('t-alone') });
    expect(await resolve(treeWorkspaceRunId('t-bare'))).toMatchObject({ repo: treeRepoName('t-bare') });
    expect(await resolve(treeWorkspaceRunId('t-theirs'))).toMatchObject({ repo: treeRepoName('t-theirs') });
  });

  it('leaves a conversation\'s repository as it is', async () => {
    expect(await resolve(conversationWorkspaceRunId('c1'))).toMatchObject({ repo: conversationRepoName('c1') });
  });
});
