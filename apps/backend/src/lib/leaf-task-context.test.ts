import { describe, it, expect, vi } from 'vitest';
import {
  buildRepoTaskContext, buildDocumentTaskContext, assembleDependencyInputsBlock, assembleLeafTaskContext,
} from './leaf-task-context.js';
import type { Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 't', body: '', column: 'todo',
  status: 'running', depth: 0, blocking: true, createdAt: '', updatedAt: '', ...over,
} as Leaf);

describe('buildRepoTaskContext', () => {
  const base = {
    baseContext: 'Task: do it', project: { giteaOwner: 'o', giteaRepo: 'r' }, branchName: 'koala/abc12345',
    hasPreviousOutputBranch: false, hasDependencyBases: false, leafRecipe: undefined,
  };

  it('names the repo, branch and mount point', () => {
    expect(buildRepoTaskContext(base)).toContain('The repository o/r is cloned at /work/repo, on a new branch "koala/abc12345"');
  });

  it('tells the leaf to continue a previous attempt when there is one', () => {
    const out = buildRepoTaskContext({ ...base, hasPreviousOutputBranch: true });
    expect(out).toContain('A PREVIOUS ATTEMPT at this same task already committed here');
  });

  it('omits the previous-attempt notice on a fresh leaf', () => {
    expect(buildRepoTaskContext(base)).not.toContain('A PREVIOUS ATTEMPT');
  });

  it('mentions dependency work only when there is some', () => {
    expect(buildRepoTaskContext(base)).not.toContain('leaves this one depends on');
    expect(buildRepoTaskContext({ ...base, hasDependencyBases: true })).toContain('leaves this one depends on');
  });

  it('adds the validation-gate section only when a recipe is declared', () => {
    expect(buildRepoTaskContext(base)).not.toContain('Validation & Quality Gate');
    const recipe = { type: 'command' as const, checks: [] };
    expect(buildRepoTaskContext({ ...base, leafRecipe: recipe })).toContain('Validation & Quality Gate');
  });
});

describe('buildDocumentTaskContext', () => {
  const base = {
    baseContext: 'Task: research it', outputPath: '/work/findings.md', wantsRepo: false,
    outputBranch: undefined, priorFindings: undefined, inputsBlock: '',
  };

  it('points the leaf at the output file as the deliverable', () => {
    expect(buildDocumentTaskContext(base)).toContain('Your answer goes in /work/findings.md');
  });

  it('says nothing about a previous attempt when there was none', () => {
    expect(buildDocumentTaskContext(base)).not.toContain('PREVIOUS ATTEMPT');
  });

  it('points at the checked-out branch when a repo leaf already wrote and pushed findings', () => {
    const out = buildDocumentTaskContext({ ...base, wantsRepo: true, outputBranch: 'koala/abc', priorFindings: 'earlier draft' });
    expect(out).toContain('already wrote /work/findings.md and pushed it to "koala/abc"');
  });

  it('inlines the prior findings directly when there is no repo to read them from', () => {
    const out = buildDocumentTaskContext({ ...base, priorFindings: 'earlier draft' });
    expect(out).toContain('Start by writing it back to /work/findings.md');
    expect(out).toContain('earlier draft');
  });

  it('appends the inputs block only when there is one', () => {
    expect(buildDocumentTaskContext(base)).not.toContain('inputs-block-marker');
    expect(buildDocumentTaskContext({ ...base, inputsBlock: 'inputs-block-marker' })).toContain('inputs-block-marker');
  });
});

describe('assembleDependencyInputsBlock', () => {
  it('produces nothing when there are no dependency findings', async () => {
    const deps = { workspaces: { writeFile: vi.fn() } };
    expect(await assembleDependencyInputsBlock(deps, 'l1', [], true)).toBe('');
    expect(deps.workspaces.writeFile).not.toHaveBeenCalled();
  });

  it('inlines findings when the leaf cannot read files', async () => {
    const deps = { workspaces: { writeFile: vi.fn() } };
    const out = await assembleDependencyInputsBlock(deps, 'l1', [{ leafId: 'd1', title: 'Dep', findings: 'result text' }], false);
    expect(out).toContain('result text');
    expect(deps.workspaces.writeFile).not.toHaveBeenCalled();
  });

  it('writes findings to files and indexes them when the leaf can read files', async () => {
    const deps = { workspaces: { writeFile: vi.fn(async () => undefined) } };
    const out = await assembleDependencyInputsBlock(deps, 'l1', [{ leafId: 'd1', title: 'Dep', findings: 'result text' }], true);
    expect(deps.workspaces.writeFile).toHaveBeenCalled();
    expect(out).toBeTruthy();
  });

  it('falls back to inlining whatever failed to write', async () => {
    const deps = { workspaces: { writeFile: vi.fn(async () => { throw new Error('disk full'); }) } };
    const out = await assembleDependencyInputsBlock(deps, 'l1', [{ leafId: 'd1', title: 'Dep', findings: 'result text' }], true);
    expect(out).toContain('result text');
  });
});

describe('assembleLeafTaskContext', () => {
  it('clones the repo and builds a repo-flavored context when there is a checkout', async () => {
    const workspaces = {
      exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async () => undefined),
    };
    const out = await assembleLeafTaskContext({ workspaces }, {
      leaf: leaf(), allLeaves: [leaf()], baseContext: 'Task: build it',
      checkout: { cloneUrl: 'https://x@gitea/o/r.git' }, giteaBaseUrl: 'http://gitea', project: { giteaOwner: 'o', giteaRepo: 'r' },
      leafRecipe: undefined, outputPath: undefined, wantsRepo: true, pack: undefined,
    });

    expect(out.branchName).toMatch(/^koala\//);
    expect(out.taskContext).toContain('cloned at /work/repo');
  });

  it('throws when the clone itself fails', async () => {
    const workspaces = {
      exec: vi.fn(async () => ({ stdout: '', stderr: 'auth failed', exitCode: 1 })),
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async () => undefined),
    };
    await expect(assembleLeafTaskContext({ workspaces }, {
      leaf: leaf(), allLeaves: [], baseContext: 'Task: build it',
      checkout: { cloneUrl: 'https://x@gitea/o/r.git' }, giteaBaseUrl: 'http://gitea', project: { giteaOwner: 'o', giteaRepo: 'r' },
      leafRecipe: undefined, outputPath: undefined, wantsRepo: true, pack: undefined,
    })).rejects.toThrow(/Could not clone/);
  });

  it('carries forward a prior checkpoint when one is found in the repo', async () => {
    const workspaces = {
      exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readFile: vi.fn(async () => 'left off here'),
      writeFile: vi.fn(async () => undefined),
    };
    const out = await assembleLeafTaskContext({ workspaces }, {
      leaf: leaf(), allLeaves: [], baseContext: 'Task: build it',
      checkout: { cloneUrl: 'https://x@gitea/o/r.git' }, giteaBaseUrl: 'http://gitea', project: { giteaOwner: 'o', giteaRepo: 'r' },
      leafRecipe: undefined, outputPath: undefined, wantsRepo: true, pack: undefined,
    });
    expect(out.taskContext).toContain('WHERE THE LAST ATTEMPT LEFT OFF');
    expect(out.taskContext).toContain('left off here');
  });

  it('builds a document context with no branch name when there is no checkout', async () => {
    const workspaces = {
      exec: vi.fn(),
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async () => undefined),
    };
    const out = await assembleLeafTaskContext({ workspaces }, {
      leaf: leaf({ id: 'l2' }), allLeaves: [], baseContext: 'Task: research it',
      checkout: undefined, giteaBaseUrl: '', project: undefined,
      leafRecipe: undefined, outputPath: '/work/findings.md', wantsRepo: false, pack: undefined,
    });
    expect(out.branchName).toBeUndefined();
    expect(out.taskContext).toContain('Your answer goes in /work/findings.md');
    expect(workspaces.exec).not.toHaveBeenCalled();
  });
});
