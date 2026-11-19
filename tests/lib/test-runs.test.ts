import { describe, expect, it } from 'vitest';
import { dueQuiet, heard, QUIET_AFTER_MS, quietLine, spoken, statusReport, type RunningFile, type RunStatus } from './test-runs.js';

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
