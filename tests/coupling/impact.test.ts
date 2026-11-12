import { describe, expect, it } from 'vitest';
import type { Ran } from './collect.js';
import { changedBetween, testsToRerun } from './impact.js';

const ran = (testFile: string, files: string[]): Ran => ({ testFile, files: Object.fromEntries(files.map((file) => [file, []])) });

describe('what changed between two gathers', () => {
  it('names a file whose content differs, one added and one removed', () => {
    expect([...changedBetween({ 'a.ts': '1', 'b.ts': '2', 'gone.ts': '3' }, { 'a.ts': '1', 'b.ts': '9', 'new.ts': '4' })].sort()).toEqual(['b.ts', 'gone.ts', 'new.ts']);
  });
});

describe('which tests a change can affect', () => {
  const runs = [
    ran('apps/backend/src/a/Service.test.ts', ['apps/backend/src/a/Service.ts', 'apps/backend/src/a/lib.ts']),
    ran('apps/backend/src/a/Service.integration.test.ts', ['apps/backend/src/a/Service.ts']),
    ran('apps/backend/src/b/Other.test.ts', ['apps/backend/src/b/Other.ts']),
  ];
  const tests = [...runs.map((run) => run.testFile), 'apps/backend/src/c/New.test.ts'];

  it('reruns every test that ran a changed file, a changed test and a test with no record yet, and nothing else', () => {
    expect(testsToRerun(runs, new Set(['apps/backend/src/a/lib.ts', 'apps/backend/src/b/Other.test.ts']), tests)).toEqual({
      full: false, tests: ['apps/backend/src/a/Service.test.ts', 'apps/backend/src/b/Other.test.ts', 'apps/backend/src/c/New.test.ts'],
    });
  });

  it('reruns everything when something coverage cannot see changed, saying what', () => {
    expect(testsToRerun(runs, new Set(['apps/backend/vitest.config.ts']), tests)).toEqual({ full: true, because: 'apps/backend/vitest.config.ts' });
    expect(testsToRerun(runs, new Set(['charts/instance/values.yaml']), tests)).toEqual({ full: true, because: 'charts/instance/values.yaml' });
  });

  it('leaves out what no test can read', () => {
    expect(testsToRerun(runs, new Set(['docs/runbook.md']), tests)).toEqual({ full: false, tests: ['apps/backend/src/c/New.test.ts'] });
  });
});
