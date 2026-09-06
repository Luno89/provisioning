import { describe, it, expect, vi } from 'vitest';
import { readLeafFindings, pushLeafBranch, verifyLeafRun, checkLeafArtifacts, decideLeafStatus } from './leaf-run-verdict.js';
import type { ValidationRecipe } from './tree-types.js';

const recipe = (checks: ValidationRecipe['checks'] = [{ id: 'c1', name: 'c1', type: 'file-exists', target: 'x' }]): ValidationRecipe =>
  ({ type: 'command', checks });

describe('readLeafFindings', () => {
  it('reads nothing when there is no output path', async () => {
    const ws = { readFile: vi.fn() };
    expect(await readLeafFindings(ws, 'l1', undefined)).toBe('');
    expect(ws.readFile).not.toHaveBeenCalled();
  });

  it('reads the declared output file', async () => {
    const ws = { readFile: vi.fn(async () => 'the findings') };
    expect(await readLeafFindings(ws, 'l1', '/work/findings.md')).toBe('the findings');
  });

  it('returns empty rather than throwing when the read fails', async () => {
    const ws = { readFile: vi.fn(async () => { throw new Error('nope'); }) };
    expect(await readLeafFindings(ws, 'l1', '/work/findings.md')).toBe('');
  });
});

describe('pushLeafBranch', () => {
  it('does nothing without a checkout', async () => {
    const ws = { exec: vi.fn() };
    expect(await pushLeafBranch(ws, 'l1', false, undefined)).toBeUndefined();
    expect(ws.exec).not.toHaveBeenCalled();
  });

  it('reports the confirmed branch on a successful push', async () => {
    const ws = { exec: vi.fn(async () => ({ stdout: 'PUSHED:koala/abc12345\n' })) };
    expect(await pushLeafBranch(ws, 'l1', true, 'koala/abc12345')).toBe('koala/abc12345');
  });

  it('reports nothing when the push does not confirm', async () => {
    const ws = { exec: vi.fn(async () => ({ stdout: '' })) };
    expect(await pushLeafBranch(ws, 'l1', true, 'koala/abc12345')).toBeUndefined();
  });
});

describe('verifyLeafRun', () => {
  const workspaces = () => ({
    exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => undefined),
  });

  it('assesses a document leaf by its written findings, nothing else', async () => {
    const deps = { validator: { inferRecipe: vi.fn(), validate: vi.fn() }, workspaces: workspaces() as any };
    const findings = `${'a real, substantive answer with plenty of prose. '.repeat(10)} Source: https://example.com`;
    const out = await verifyLeafRun(deps, {
      leafId: 'l1', outputPath: '/work/findings.md', findings,
      requireSources: true, finalValidationSummary: undefined, leafRecipe: undefined, isDocumentLeaf: true,
      cwd: undefined, verifyCommand: undefined, workLanguage: undefined,
    });
    expect(out.outcome).toBe('passed');
    expect(deps.validator.validate).not.toHaveBeenCalled();
  });

  it('uses the round loop\'s final validation summary when there is one', async () => {
    const deps = { validator: { inferRecipe: vi.fn(), validate: vi.fn() }, workspaces: workspaces() as any };
    const out = await verifyLeafRun(deps, {
      leafId: 'l1', outputPath: undefined, findings: '', requireSources: true,
      finalValidationSummary: { passed: true, type: 'command', totalChecks: 1, passedChecks: 1, failedChecks: 0, checks: [], diagnosticReport: 'ok' },
      leafRecipe: undefined, isDocumentLeaf: false, cwd: undefined, verifyCommand: undefined, workLanguage: undefined,
    });
    expect(out).toEqual({ outcome: 'passed', output: 'ok' });
  });

  it('validates against the leaf recipe when no summary is carried forward', async () => {
    const ws = workspaces();
    const deps = {
      validator: { inferRecipe: vi.fn(), validate: vi.fn(async () => ({ passed: false, type: 'command' as const, totalChecks: 1, passedChecks: 0, failedChecks: 1, checks: [], diagnosticReport: 'broke' })) },
      workspaces: ws as any,
    };
    const out = await verifyLeafRun(deps, {
      leafId: 'l1', outputPath: undefined, findings: '', requireSources: true, finalValidationSummary: undefined,
      leafRecipe: recipe(), isDocumentLeaf: false, cwd: '/work/repo', verifyCommand: undefined, workLanguage: undefined,
    });
    expect(out).toEqual({ outcome: 'failed', output: 'broke' });
  });

  it('falls back to the default verify command when there is no recipe at all', async () => {
    const ws = workspaces();
    ws.exec.mockResolvedValue({ stdout: 'KOALA_VERIFY_EXIT=0\n', stderr: '', exitCode: 0 });
    const deps = { validator: { inferRecipe: vi.fn(async () => undefined), validate: vi.fn() }, workspaces: ws as any };
    const out = await verifyLeafRun(deps, {
      leafId: 'l1', outputPath: undefined, findings: '', requireSources: true, finalValidationSummary: undefined,
      leafRecipe: undefined, isDocumentLeaf: false, cwd: '/work/repo', verifyCommand: 'npm test', workLanguage: 'node',
    });
    expect(out.outcome).toBe('passed');
  });

  it('is unverified when nothing at all can check the work', async () => {
    const deps = { validator: { inferRecipe: vi.fn(async () => undefined), validate: vi.fn() }, workspaces: workspaces() as any };
    const out = await verifyLeafRun(deps, {
      leafId: 'l1', outputPath: undefined, findings: '', requireSources: true, finalValidationSummary: undefined,
      leafRecipe: undefined, isDocumentLeaf: false, cwd: undefined, verifyCommand: undefined, workLanguage: undefined,
    });
    expect(out).toEqual({ outcome: 'unverified', output: '' });
  });
});

describe('checkLeafArtifacts', () => {
  it('skips the check for a document leaf with nothing declared', async () => {
    const ws = { exec: vi.fn() };
    const out = await checkLeafArtifacts(ws, 'l1', false, undefined, 'main', undefined);
    expect(out).toEqual({ outcome: 'none', missing: [], moved: [] });
    expect(ws.exec).not.toHaveBeenCalled();
  });

  it('reports what the artifact check script found', async () => {
    const ws = { exec: vi.fn(async () => ({ stdout: 'KOALA_ARTIFACTS=present\n' })) };
    const out = await checkLeafArtifacts(ws, 'l1', true, ['src/server.js'], 'main', undefined);
    expect(out.outcome).toBe('present');
  });
});

describe('decideLeafStatus', () => {
  const base = {
    leafId: 'l1', outputPath: undefined, verifyOutcome: 'passed' as const, declaredVerify: true,
    pushedBranch: 'koala/abc', artifactsOutcome: 'present' as const, dockerProblems: '', claimed: true,
  };

  it('settles as succeeded when everything checks out', () => {
    expect(decideLeafStatus(base).settled).toBe('succeeded');
  });

  it('demotes an undeclared pass with nothing committed to unverified', () => {
    const out = decideLeafStatus({ ...base, declaredVerify: false, pushedBranch: undefined });
    expect(out.earned).toBe('unverified');
  });

  it('overrides to failed on a Dockerfile problem regardless of everything else', () => {
    expect(decideLeafStatus({ ...base, dockerProblems: 'no lockfile copied' }).settled).toBe('failed');
  });

  it('trusts a document leaf\'s verify outcome directly, with no evidence gate', () => {
    const out = decideLeafStatus({ ...base, outputPath: '/work/findings.md', pushedBranch: undefined, declaredVerify: false });
    expect(out.earned).toBe('passed');
  });
});
