import { describe, it, expect, vi } from 'vitest';
import { resolveActiveRecipe, readRepoRoundDetails, runValidationRound } from './leaf-validation-round.js';
import type { ValidationRecipe } from './tree-types.js';

const recipe = (checks: ValidationRecipe['checks'] = [{ id: 'c1', name: 'c1', type: 'file-exists', target: 'x' }]): ValidationRecipe =>
  ({ type: 'command', checks });

describe('resolveActiveRecipe', () => {
  it('uses the leaf recipe as-is when it has checks', async () => {
    const deps = { validator: { inferRecipe: vi.fn() } };
    const out = await resolveActiveRecipe(deps, recipe(), false, {} as any);
    expect(out?.checks.length).toBe(1);
    expect(deps.validator.inferRecipe).not.toHaveBeenCalled();
  });

  it('infers a recipe for a non-document leaf with none declared', async () => {
    const inferred = recipe();
    const deps = { validator: { inferRecipe: vi.fn(async () => inferred) } };
    const out = await resolveActiveRecipe(deps, undefined, false, {} as any);
    expect(out).toBe(inferred);
  });

  it('never infers for a document leaf, even with no recipe', async () => {
    const deps = { validator: { inferRecipe: vi.fn() } };
    const out = await resolveActiveRecipe(deps, undefined, true, {} as any);
    expect(out).toBeUndefined();
    expect(deps.validator.inferRecipe).not.toHaveBeenCalled();
  });

  it('infers when the declared recipe has no checks', async () => {
    const inferred = recipe();
    const deps = { validator: { inferRecipe: vi.fn(async () => inferred) } };
    const out = await resolveActiveRecipe(deps, recipe([]), false, {} as any);
    expect(out).toBe(inferred);
  });
});

describe('readRepoRoundDetails', () => {
  it('reports commits and changed files from a clean single exec', async () => {
    const deps = { workspaces: { exec: vi.fn(async () => ({ stdout: 'STATUS:\n M a.ts\nCOMMITS:\n2\n', exitCode: 0 })) } };
    const out = await readRepoRoundDetails(deps, 'l1');
    expect(out).toEqual({ commits: 2, changedFiles: ['a.ts'] });
  });

  it('returns undefined rather than an empty object when nothing changed', async () => {
    const deps = { workspaces: { exec: vi.fn(async () => ({ stdout: 'STATUS:\nCOMMITS:\n', exitCode: 0 })) } };
    expect(await readRepoRoundDetails(deps, 'l1')).toBeUndefined();
  });

  it('returns undefined, not a throw, when the exec itself fails', async () => {
    const deps = { workspaces: { exec: vi.fn(async () => { throw new Error('boom'); }) } };
    expect(await readRepoRoundDetails(deps, 'l1')).toBeUndefined();
  });
});

describe('runValidationRound', () => {
  const workspaces = () => ({
    exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => undefined),
  });

  it('reports no-recipe when nothing can be checked', async () => {
    const deps = { validator: { inferRecipe: vi.fn(async () => undefined), validate: vi.fn() }, workspaces: workspaces() as any };
    const out = await runValidationRound(deps, {
      round: 1, leafId: 'l1', leafRecipe: undefined, isDocumentLeaf: false, cwd: undefined,
      previousRound: undefined, maxRounds: 4, workerStoppedBecause: undefined,
    });
    expect(out).toEqual({ outcome: 'no-recipe' });
  });

  it('reports passed when every check passes', async () => {
    const summary = { passed: true, type: 'command' as const, totalChecks: 1, passedChecks: 1, failedChecks: 0, checks: [], diagnosticReport: '' };
    const deps = { validator: { inferRecipe: vi.fn(), validate: vi.fn(async () => summary) }, workspaces: workspaces() as any };
    const out = await runValidationRound(deps, {
      round: 1, leafId: 'l1', leafRecipe: recipe(), isDocumentLeaf: false, cwd: undefined,
      previousRound: undefined, maxRounds: 4, workerStoppedBecause: undefined,
    });
    expect(out.outcome).toBe('passed');
  });

  it('reports continue with a feedback prompt on a fixable first failure', async () => {
    const summary = {
      passed: false, type: 'command' as const, totalChecks: 1, passedChecks: 0, failedChecks: 1,
      checks: [{ id: 'c1', name: 'c1', type: 'run-command', passed: false, message: 'nope', durationMs: 1 }],
      diagnosticReport: 'nope',
    };
    const deps = { validator: { inferRecipe: vi.fn(), validate: vi.fn(async () => summary) }, workspaces: workspaces() as any };
    const out = await runValidationRound(deps, {
      round: 1, leafId: 'l1', leafRecipe: recipe(), isDocumentLeaf: false, cwd: undefined,
      previousRound: undefined, maxRounds: 4, workerStoppedBecause: undefined,
    });
    expect(out.outcome).toBe('continue');
    if (out.outcome === 'continue') expect(out.assessment.feedbackPrompt).toBeTruthy();
  });

  it('reports halt once max rounds are reached', async () => {
    const summary = {
      passed: false, type: 'command' as const, totalChecks: 1, passedChecks: 0, failedChecks: 1,
      checks: [{ id: 'c1', name: 'c1', type: 'run-command', passed: false, message: 'nope', durationMs: 1 }],
      diagnosticReport: 'nope',
    };
    const deps = { validator: { inferRecipe: vi.fn(), validate: vi.fn(async () => summary) }, workspaces: workspaces() as any };
    const out = await runValidationRound(deps, {
      round: 4, leafId: 'l1', leafRecipe: recipe(), isDocumentLeaf: false, cwd: undefined,
      previousRound: undefined, maxRounds: 4, workerStoppedBecause: undefined,
    });
    expect(out.outcome).toBe('halt');
  });
});
