import { describe, expect, it } from 'vitest';
import { afterTest, dueQuiet, heard, QUIET_AFTER_MS, quietLine, spoken, statusReport, testName, withWorkers, type RunningFile, type RunStatus, type TaskShape } from './test-runs.js';

const MIN = 60_000;

const aFile = (over: Partial<RunningFile> = {}): RunningFile => ({ file: 'apps/backend/src/infrastructure/routes/app-names.integration.test.ts', startedAt: 0, doing: 'afterAll', doingSince: 0, changedAt: 0, ...over });

describe('what a run heard', () => {
  it('keeps the last line said, and counts it as something happening', () => {
    expect(heard(aFile(), 'first\nsecond\n\n', 5_000)).toMatchObject({ lastLine: 'second', changedAt: 5_000 });
  });

  it('counts the same line said again as quiet, so a wait repeating itself does not look like progress', () => {
    const file = heard(aFile(), '    still waiting for x (y)', 5_000);
    expect(heard(file, '    still waiting for x (y)\n', 90_000)).toMatchObject({ lastLine: 'still waiting for x (y)', changedAt: 5_000 });
    expect(heard(file, '    still waiting for x (z)', 90_000).changedAt).toBe(90_000);
  });

  it('ignores output with no words in it', () => {
    expect(heard(aFile({ lastLine: 'before', changedAt: 1 }), '\n  \n', 9_000)).toMatchObject({ lastLine: 'before', changedAt: 1 });
  });
});

describe('how quiet is said', () => {
  it('says seconds under a minute and whole minutes after', () => {
    expect(spoken(42_400)).toBe('42 s');
    expect(spoken(4 * MIN + 59_000)).toBe('4 min');
  });

  it('names the file, what it is doing, how long it has been quiet and what it said last', () => {
    expect(quietLine(aFile({ lastLine: 'still waiting for every deployment to be failed (shop-3f2a1b: deploying)' }), 4 * MIN))
      .toBe('app-names.integration.test.ts › afterAll: quiet 4 min; last said: still waiting for every deployment to be failed (shop-3f2a1b: deploying)');
    expect(quietLine(aFile(), 4 * MIN)).toBe('app-names.integration.test.ts › afterAll: quiet 4 min; it has said nothing yet');
  });
});

describe('when a quiet file is told', () => {
  const run = (file: RunningFile): RunStatus => ({ pid: 7, checkout: '/c', workspace: 'apps/backend', startedAt: 0, files: { one: file } });

  it('waits longer than any integration test has taken, then tells it again each time as long again goes by, never ending the run', () => {
    const told = new Map();
    const file = aFile();
    expect(dueQuiet([run(file)], QUIET_AFTER_MS - 1, told, QUIET_AFTER_MS)).toEqual([]);
    expect(dueQuiet([run(file)], QUIET_AFTER_MS, told, QUIET_AFTER_MS)).toEqual([quietLine(file, QUIET_AFTER_MS)]);
    expect(dueQuiet([run(file)], QUIET_AFTER_MS + MIN, told, QUIET_AFTER_MS)).toEqual([]);
    expect(dueQuiet([run(file)], 2 * QUIET_AFTER_MS, told, QUIET_AFTER_MS)).toEqual([quietLine(file, 2 * QUIET_AFTER_MS)]);
    expect(QUIET_AFTER_MS).toBe(4 * MIN);
  });

  it('starts counting again once the file says something new', () => {
    const told = new Map();
    expect(dueQuiet([run(aFile())], QUIET_AFTER_MS, told, QUIET_AFTER_MS)).toHaveLength(1);
    const moved = aFile({ changedAt: QUIET_AFTER_MS + 1, lastLine: 'next' });
    expect(dueQuiet([run(moved)], QUIET_AFTER_MS + 2, told, QUIET_AFTER_MS)).toEqual([]);
    expect(dueQuiet([run(moved)], 2 * QUIET_AFTER_MS + 1, told, QUIET_AFTER_MS)).toEqual([quietLine(moved, 2 * QUIET_AFTER_MS + 1)]);
  });
});

describe('the status of every live run', () => {
  it('lists each run with its checkout, workspace, pid and how long it has run, then each file running and how long it has been quiet', () => {
    const runs: RunStatus[] = [
      { pid: 11, checkout: '/home/a/provisioning', workspace: 'apps/backend', startedAt: 0, files: { x: aFile({ changedAt: 3 * MIN, lastLine: 'still waiting for y' }) } },
      { pid: 12, checkout: '/home/a/wt', workspace: 'packages/provision', startedAt: 9 * MIN, files: {} },
    ];
    expect(statusReport(runs, 10 * MIN)).toEqual([
      '2 test runs live on this machine',
      '/home/a/provisioning · apps/backend · pid 11 · running 10 min · 1 file running',
      '  apps/backend/src/infrastructure/routes/app-names.integration.test.ts › afterAll: quiet 7 min; last said: still waiting for y',
      '/home/a/wt · packages/provision · pid 12 · running 1 min · no file running',
    ]);
    expect(statusReport([], 0)).toEqual(['no test runs are live on this machine']);
  });
});

describe('what a worker says its file is doing', () => {
  const tree = (): { first: TaskShape; second: TaskShape; last: TaskShape } => {
    const file: TaskShape = { id: 'f', name: 'x.test.ts', type: 'suite', mode: 'run', tasks: [] };
    file.file = file;
    const outer: TaskShape = { id: 's', name: 'the outer', type: 'suite', mode: 'run', suite: file, file, tasks: [] };
    const first: TaskShape = { id: 't1', name: 'does one', type: 'test', mode: 'run', suite: outer, file, result: { state: 'pass' } };
    const second: TaskShape = { id: 't2', name: 'does two', type: 'test', mode: 'run', suite: outer, file };
    const skipped: TaskShape = { id: 't3', name: 'is skipped', type: 'test', mode: 'skip', suite: file, file };
    const last: TaskShape = { id: 't4', name: 'does last', type: 'test', mode: 'run', suite: file, file };
    outer.tasks = [first, second];
    file.tasks = [outer, skipped, last];
    return { first, second, last };
  };

  it('names a test by its suites and its own name, leaving out the file', () => {
    expect(testName(tree().second)).toBe('the outer › does two');
    expect(testName(tree().last)).toBe('does last');
  });

  it('after a test, says the next is coming, a suite\'s afterAll, or the file\'s afterAll once no test is left to run', () => {
    const { first, second, last } = tree();
    expect(afterTest(first)).toBe('between tests');
    second.result = { state: 'pass' };
    expect(afterTest(second)).toBe('the outer › afterAll');
    last.result = { state: 'pass' };
    expect(afterTest(last)).toBe('afterAll');
  });

  it('takes what a worker said over what the run kept, when it is newer, and counts it as something happening', () => {
    const run: RunStatus = { pid: 7, checkout: '/c', workspace: 'w', startedAt: 0, files: { f: aFile({ doing: 'loading', doingSince: 10, changedAt: 20 }), g: aFile({ doing: 'loading', doingSince: 10, changedAt: 10 }) } };
    expect(withWorkers(run, [{ file: 'f', doing: 'a test', since: 30 }, { file: 'g', doing: 'older', since: 5 }, { file: 'h', doing: 'gone', since: 40 }]).files).toEqual({
      f: aFile({ doing: 'a test', doingSince: 30, changedAt: 30 }),
      g: aFile({ doing: 'loading', doingSince: 10, changedAt: 10 }),
    });
  });
});
