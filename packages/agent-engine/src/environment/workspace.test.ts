import { describe, it, expect } from 'vitest';
import { describeWorkspace, type RunWorkspace } from './workspace.js';

const workspace: RunWorkspace = {
  runId: 'run-1', ownerId: 'u', agent: 'executor', image: 'koala/base', provides: ['git', 'node'],
  lifetimeMs: 30 * 60_000, cpu: '2', memory: '2Gi', egress: [], env: [], egressMode: 'declared',
};

describe('describeWorkspace', () => {
  it('tells a run of its own sandbox that /work is its working directory and dies with it', () => {
    const text = describeWorkspace(workspace);
    expect(text).toContain('- /work is your working directory');
    expect(text).toContain('belongs to this run alone and is destroyed when the run ends');
  });

  it('tells a run narrowed to a worktree where it actually is, and not to wander out of it', () => {
    const text = describeWorkspace({ ...workspace, persistent: true }, 'judge/leaf-1');
    expect(text).toContain('- /work/judge/leaf-1 is your working directory');
    expect(text).toContain('use paths relative to it');
    expect(text).toContain('do not cd out of your worktree');
    expect(text).not.toContain('- /work is your working directory');
  });

  it('tells a run in a tree sandbox that the sandbox outlives it and is shared', () => {
    const text = describeWorkspace({ ...workspace, persistent: true }, 'trees/leaf-1');
    expect(text).toContain('belongs to the tree, not to this run');
    expect(text).not.toContain('destroyed when the run ends');
  });
});
