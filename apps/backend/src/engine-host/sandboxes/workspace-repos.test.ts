import { describe, it, expect } from 'vitest';
import { pathInRepo, placeArtifacts, repoForWorkspace, workspaceOwnerOf } from './workspace-repos.js';

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
