import { describe, it, expect, vi } from 'vitest';
import {
  readRepoProgress, readDocumentProgress, buildOnStepDriver, buildSandboxDriver, buildSaveMemoryDriver,
  buildExtendBudgetDriver, buildCheckpointDriver,
} from './leaf-round-drivers.js';

describe('readRepoProgress', () => {
  it('parses commit count and inserted-line count from one exec', async () => {
    const workspaces = { exec: vi.fn(async () => ({ stdout: 'COMMITS:\na1\na2\nCHANGED:\n 2 files changed, 40 insertions(+)\n' })) };
    const out = await readRepoProgress(workspaces, 'l1', 'main');
    expect(out.commits).toBe(2);
    expect(out.changedLines).toBe(40);
    expect(out.raw.commits).toBe('a1\na2');
  });

  it('defaults to zero on an empty repo rather than throwing', async () => {
    const workspaces = { exec: vi.fn(async () => { throw new Error('boom'); }) };
    const out = await readRepoProgress(workspaces, 'l1', 'main');
    expect(out).toEqual({ commits: 0, changedLines: 0, raw: { commits: '', changed: '' } });
  });
});

describe('readDocumentProgress', () => {
  it('reads the output file and assesses it', async () => {
    const workspaces = { readFile: vi.fn(async () => 'short') };
    const out = await readDocumentProgress(workspaces, 'l1', '/work/findings.md', true);
    expect(out.chars).toBe(5);
    expect(out.outcome).toBe('failed');
  });
});

describe('buildOnStepDriver', () => {
  it('heartbeats and records the step, redacting secrets', async () => {
    const db = { appendLeafStep: vi.fn(async (_trace: any) => undefined) };
    const onBeat = vi.fn();
    const driver = buildOnStepDriver({ db }, { id: 'l1', ownerId: 'u1', branchId: 'b1' }, () => ['sekret12345'], onBeat);

    driver({ step: 1, tokens: 10, text: 'used sekret12345 here' } as any);
    await Promise.resolve();

    expect(onBeat).toHaveBeenCalledWith(expect.objectContaining({ step: 1 }));
    expect(db.appendLeafStep).toHaveBeenCalled();
    const saved = db.appendLeafStep.mock.calls[0]?.[0] as any;
    expect(JSON.stringify(saved.step)).not.toContain('sekret12345');
  });
});

describe('buildSandboxDriver', () => {
  it('scopes every call to the given leaf id', async () => {
    const workspaces = { exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false })), readFile: vi.fn(), writeFile: vi.fn() };
    const driver = buildSandboxDriver(workspaces, 'l1');
    await driver.exec('ls');
    expect(workspaces.exec).toHaveBeenCalledWith('l1', 'ls');
  });
});

describe('buildSaveMemoryDriver', () => {
  it('admits a memory item built from the callback payload', async () => {
    const admit = vi.fn(async () => ({ action: 'ADD' as const }));
    const driver = buildSaveMemoryDriver(admit, { id: 'l1', ownerId: 'u1' }, () => []);
    const out = await driver({ category: 'lessons_learned', title: 't', text: 'x', suggestedScope: 'project' });
    expect(out).toEqual({ action: 'ADD' });
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'u1', category: 'lessons_learned' }));
  });
});

describe('buildExtendBudgetDriver', () => {
  const leaf = { id: 'l1', ownerId: 'u1', branchId: 'b1', title: 't', column: 'todo', status: 'running', depth: 0, blocking: true, createdAt: '', updatedAt: '' } as any;

  it('reads repo progress via the shared helper, not a duplicated inline parse', async () => {
    const workspaces = { exec: vi.fn(async () => ({ stdout: 'COMMITS:\na1\nCHANGED:\n 1 file changed, 5 insertions(+)\n' })), readFile: vi.fn() };
    const db = { getLeaves: vi.fn(async () => [leaf]) };
    const progress = { get: vi.fn(() => undefined), set: vi.fn() };
    const driver = buildExtendBudgetDriver({ workspaces, db }, {
      leaf, checkout: true, branchName: 'koala/abc', defaultBranch: 'main', outputPath: undefined,
      conventions: undefined, requireSources: true, progress, onBeat: vi.fn(),
    });

    await driver({ exhausted: 'steps', extensionsUsed: 0, step: 5, tokensUsed: 100, originalMaxSteps: 5, originalMaxTokens: 1000, thrashing: false, circling: false, silent: false });

    expect(progress.set).toHaveBeenCalledWith(expect.objectContaining({ commits: 1, changedLines: 5 }));
  });

  it('reads document progress for an output-path leaf, not repo progress', async () => {
    const workspaces = { readFile: vi.fn(async () => 'x'.repeat(500)), exec: vi.fn() };
    const db = { getLeaves: vi.fn(async () => [leaf]) };
    const progress = { get: vi.fn(() => undefined), set: vi.fn() };
    const driver = buildExtendBudgetDriver({ workspaces, db }, {
      leaf, checkout: false, branchName: undefined, defaultBranch: 'main', outputPath: '/work/findings.md',
      conventions: undefined, requireSources: false, progress, onBeat: vi.fn(),
    });

    await driver({ exhausted: 'steps', extensionsUsed: 0, step: 5, tokensUsed: 100, originalMaxSteps: 5, originalMaxTokens: 1000, thrashing: false, circling: false, silent: false });

    expect(progress.set).toHaveBeenCalledWith(expect.objectContaining({ findingsChars: 500 }));
  });

  it('returns undefined rather than throwing when the probe itself fails', async () => {
    const workspaces = { exec: vi.fn(async () => { throw new Error('boom'); }), readFile: vi.fn() };
    const db = { getLeaves: vi.fn(async () => { throw new Error('boom'); }) };
    const progress = { get: vi.fn(() => undefined), set: vi.fn() };
    const driver = buildExtendBudgetDriver({ workspaces, db }, {
      leaf, checkout: false, branchName: undefined, defaultBranch: 'main', outputPath: undefined,
      conventions: undefined, requireSources: true, progress, onBeat: () => { throw new Error('beat failed'); },
    });

    const out = await driver({ exhausted: 'steps', extensionsUsed: 0, step: 1, tokensUsed: 1, originalMaxSteps: 1, originalMaxTokens: 1, thrashing: false, circling: false, silent: false });
    expect(out).toBeUndefined();
  });
});

describe('buildCheckpointDriver', () => {
  const leaf = { id: 'l1', title: 't' };

  it('saves document findings and updates the progress cell for a document leaf', async () => {
    const workspaces = { readFile: vi.fn(async () => 'x'.repeat(500)), exec: vi.fn(), writeFile: vi.fn() };
    const db = { saveLeaf: vi.fn(async () => undefined) };
    const progress = { get: vi.fn(), set: vi.fn() };
    const driver = buildCheckpointDriver({ workspaces, db, currentLeaf: async () => ({ ...leaf, ownerId: 'u1', branchId: 'b1', column: 'todo', status: 'running', depth: 0, blocking: true, createdAt: '', updatedAt: '' } as any) }, {
      leaf, checkout: false, branchName: undefined, defaultBranch: 'main', outputPath: '/work/findings.md',
      requireSources: false, progress, onBeat: vi.fn(),
    });

    const out = await driver({ number: 1, tokensUsed: 10, maxTokens: 100 });
    expect(out?.artifact).toBeTruthy();
    expect(db.saveLeaf).toHaveBeenCalledWith(expect.objectContaining({ findings: expect.any(String) }));
    expect(progress.set).toHaveBeenCalledWith(expect.objectContaining({ findingsChars: 500 }));
  });

  it('pushes a repo checkpoint branch and records the output branch', async () => {
    const workspaces = {
      exec: vi.fn(async (leafId: string, script: string) =>
        script.includes('COMMITS')
          ? { stdout: 'COMMITS:\na1\nCHANGED:\n 1 file changed, 2 insertions(+)\n' }
          : { stdout: 'CHECKPOINT:koala/abc12345:9f8e7d6\n' }),
      readFile: vi.fn(),
      writeFile: vi.fn(async () => undefined),
    };
    const db = { saveLeaf: vi.fn(async () => undefined) };
    const progress = { get: vi.fn(), set: vi.fn() };
    const driver = buildCheckpointDriver({ workspaces, db, currentLeaf: async () => ({ id: 'l1' } as any) }, {
      leaf, checkout: true, branchName: 'koala/abc12345', defaultBranch: 'main', outputPath: undefined,
      requireSources: true, progress, onBeat: vi.fn(),
    });

    const out = await driver({ number: 1, tokensUsed: 10, maxTokens: 100 });
    expect(out).toMatchObject({ sha: '9f8e7d6', branch: 'koala/abc12345' });
    expect(db.saveLeaf).toHaveBeenCalledWith(expect.objectContaining({ outputBranch: 'koala/abc12345' }));
  });

  it('returns undefined rather than throwing when the driver itself fails', async () => {
    const workspaces = { exec: vi.fn(async () => { throw new Error('boom'); }), readFile: vi.fn(), writeFile: vi.fn() };
    const db = { saveLeaf: vi.fn() };
    const progress = { get: vi.fn(), set: vi.fn() };
    const driver = buildCheckpointDriver({ workspaces, db, currentLeaf: async () => undefined }, {
      leaf, checkout: false, branchName: undefined, defaultBranch: 'main', outputPath: undefined,
      requireSources: true, progress, onBeat: () => { throw new Error('beat failed'); },
    });

    expect(await driver({ number: 1, tokensUsed: 10, maxTokens: 100 })).toBeUndefined();
  });
});
