import { describe, expect, it } from 'vitest';
import type { Ran } from './collect.js';
import { changedBetween, hunkLines, ranLine, testsToRerun } from './impact.js';

const ran = (testFile: string, files: string[]): Ran => ({ testFile, files: Object.fromEntries(files.map((file) => [file, []])) });
const whole = (files: string[]): Map<string, 'whole'> => new Map(files.map((file) => [file, 'whole']));
const MODULE = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 }, count: 1, fn: '' };
const fn = (name: string, from: number, to: number, count: number) => ({ start: { line: from, column: 1 }, end: { line: to, column: 2 }, count, fn: name });

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
    expect(testsToRerun(runs, whole(['apps/backend/src/a/lib.ts', 'apps/backend/src/b/Other.test.ts']), tests)).toEqual({
      full: false, tests: ['apps/backend/src/a/Service.test.ts', 'apps/backend/src/b/Other.test.ts', 'apps/backend/src/c/New.test.ts'],
    });
  });

  it('reruns everything when something coverage cannot see changed, saying what', () => {
    expect(testsToRerun(runs, whole(['apps/backend/vitest.config.ts']), tests)).toEqual({ full: true, because: 'apps/backend/vitest.config.ts' });
    expect(testsToRerun(runs, whole(['charts/instance/values.yaml']), tests)).toEqual({ full: true, because: 'charts/instance/values.yaml' });
  });

  it('reruns everything when what measures coverage changed, and treats the rest of the coupling tool as code its own tests ran', () => {
    expect(testsToRerun(runs, whole(['tests/coupling/collect.ts']), tests)).toEqual({ full: true, because: 'tests/coupling/collect.ts' });
    expect(testsToRerun([...runs, ran('tests/coupling/impact.test.ts', ['tests/coupling/impact.ts'])], whole(['tests/coupling/impact.ts']), [...tests, 'tests/coupling/impact.test.ts'])).toEqual({
      full: false, tests: ['apps/backend/src/c/New.test.ts', 'tests/coupling/impact.test.ts'],
    });
  });

  it('leaves out what no test can read', () => {
    expect(testsToRerun(runs, whole(['docs/runbook.md']), tests)).toEqual({ full: false, tests: ['apps/backend/src/c/New.test.ts'] });
  });
});

describe('which tests ran the lines that changed', () => {
  const file = 'apps/backend/src/a/Service.ts';
  const calls = { testFile: 'apps/backend/src/a/calls.test.ts', files: { [file]: [MODULE, fn('used', 3, 9, 2), fn('inner', 5, 6, 0), fn('unused', 11, 14, 0)] } };
  const loads = { testFile: 'apps/backend/src/b/loads.test.ts', files: { [file]: [MODULE, fn('used', 3, 9, 0), fn('unused', 11, 14, 0)] } };
  const tests = [calls.testFile, loads.testFile];

  it('reruns only a test that called the function a changed line is in', () => {
    expect(testsToRerun([calls, loads], new Map([[file, new Set([4])]]), tests)).toEqual({ full: false, tests: [calls.testFile] });
  });

  it('reruns nobody for a change inside a function no test called', () => {
    expect(testsToRerun([calls, loads], new Map([[file, new Set([12])]]), tests)).toEqual({ full: false, tests: [] });
  });

  it('takes the innermost function, so a change in a callback never called reruns nothing', () => {
    expect(ranLine(calls.files[file]!, 5)).toBe(false);
    expect(ranLine(calls.files[file]!, 7)).toBe(true);
  });

  it('takes a line inside a block that never ran, such as a function V8 counts only as its parent\'s block, as not run', () => {
    const wired = [MODULE, fn('make', 3, 12, 1), { start: { line: 4, column: 20 }, end: { line: 11, column: 2 }, count: 0 }];
    expect(ranLine(wired, 7)).toBe(false);
    expect(ranLine(wired, 4)).toBe(true);
    expect(ranLine(wired, 12)).toBe(true);
  });

  it('reruns every test that loaded the file for a change outside any function', () => {
    expect(testsToRerun([calls, loads], new Map([[file, new Set([1])]]), tests)).toEqual({ full: false, tests: tests.slice().sort() });
  });
});

describe('the lines a diff changes, as numbered before it', () => {
  it('takes changed and removed lines, and both neighbours of an insertion', () => {
    expect([...hunkLines('@@ -3,2 +3,3 @@\n-a\n@@ -10 +11 @@\n@@ -20,0 +22,4 @@\n')].sort((a, b) => a - b)).toEqual([3, 4, 10, 20, 21]);
  });
});
