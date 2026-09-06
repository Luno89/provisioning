import { describe, it, expect, vi } from 'vitest';
import { settleFailedLeaf, settleSucceededLeaf } from './leaf-run-settle.js';
import type { Leaf } from './leaves.js';

const leaf: Leaf = {
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 't', column: 'todo', status: 'running',
  depth: 0, blocking: true, createdAt: '', updatedAt: '',
};

const deps = (over: Record<string, unknown> = {}) => ({
  workspaces: { exec: vi.fn(async () => ({ stdout: '' })) },
  db: { saveLeaf: vi.fn(async () => undefined) },
  currentLeaf: vi.fn(async () => leaf),
  ...over,
} as any);

describe('settleFailedLeaf', () => {
  it('saves partial progress and throws a composed error', async () => {
    const d = deps();
    await expect(settleFailedLeaf(d, {
      leafId: 'l1', checkout: false, pushedBranch: 'koala/abc', project: undefined, findings: '',
      spent: { tokens: 100 }, runSucceeded: false, runSummary: 'ran out of steps',
      verify: { outcome: 'failed', output: 'test failed' }, artifactsOutcome: 'missing', artifactsMissing: ['src/a.ts'],
      dockerProblems: '', verifyCommand: 'npm test',
    })).rejects.toThrow(/ran out of steps/);

    expect(d.db.saveLeaf).toHaveBeenCalledWith(expect.objectContaining({ outputBranch: 'koala/abc' }));
  });

  it('names the mismatch when the agent claimed success but checks failed', async () => {
    const d = deps();
    await expect(settleFailedLeaf(d, {
      leafId: 'l1', checkout: false, pushedBranch: undefined, project: undefined, findings: '',
      spent: undefined, runSucceeded: true, runSummary: 'done!',
      verify: { outcome: 'failed', output: 'nope' }, artifactsOutcome: 'none', artifactsMissing: [],
      dockerProblems: '', verifyCommand: 'npm test',
    })).rejects.toThrow(/agent reported success, but the checks failed/);
  });

  it('includes repo state only when there was a checkout', async () => {
    const d = deps({ workspaces: { exec: vi.fn(async () => ({ stdout: 'COMMITS:\na1b2c3\n' })) } });
    await expect(settleFailedLeaf(d, {
      leafId: 'l1', checkout: true, pushedBranch: undefined, project: undefined, findings: '',
      spent: undefined, runSucceeded: false, runSummary: 'x', verify: { outcome: 'unverified', output: '' },
      artifactsOutcome: 'none', artifactsMissing: [], dockerProblems: '', verifyCommand: undefined,
    })).rejects.toThrow(/State of the repository/);
  });
});

describe('settleSucceededLeaf', () => {
  const checks = { verify: { outcome: 'passed' }, artifacts: { outcome: 'present' }, combined: 'passed', settled: 'succeeded' };

  it('merges a passed, pushed branch and records success', async () => {
    const d = deps({ workspaces: { exec: vi.fn(async () => ({ stdout: 'MERGE=merged\n' })) } });
    const out = await settleSucceededLeaf(d, {
      leafId: 'l1', pushedBranch: 'koala/abc', combined: 'passed', dockerProblems: '',
      spent: { tokens: 50 }, checks, runSummary: 'done', runTokensUsed: 50, project: undefined,
      findings: '', secretsInPlay: () => [],
    });

    expect(out).toEqual({ leafId: 'l1', tokensUsed: 50, summary: 'done' });
    expect(d.db.saveLeaf).toHaveBeenCalledWith(expect.objectContaining({ merged: true, verified: true }));
  });

  it('does not attempt a merge without a pushed branch', async () => {
    const d = deps();
    await settleSucceededLeaf(d, {
      leafId: 'l1', pushedBranch: undefined, combined: 'unverified', dockerProblems: '',
      spent: undefined, checks, runSummary: 'done', runTokensUsed: 10, project: undefined,
      findings: '', secretsInPlay: () => [],
    });
    expect(d.workspaces.exec).not.toHaveBeenCalled();
  });

  it('skips the merge attempt entirely on a Dockerfile problem', async () => {
    const d = deps();
    await settleSucceededLeaf(d, {
      leafId: 'l1', pushedBranch: 'koala/abc', combined: 'passed', dockerProblems: 'no lockfile',
      spent: undefined, checks, runSummary: 'done', runTokensUsed: 10, project: undefined,
      findings: '', secretsInPlay: () => [],
    });
    expect(d.workspaces.exec).not.toHaveBeenCalled();
  });
});
