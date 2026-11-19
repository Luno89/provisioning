import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followQuiet, type QuietNotice, type RunSource } from './quiet-follow.js';
import { aFile, aRun, MIN } from './fixture-runs.js';
import { QUIET_AFTER_MS, quietLine, type RunStatus } from './test-runs.js';

function aSource(first: RunStatus[]): RunSource & { now: (runs: RunStatus[]) => void } {
  let current = first;
  let changed = (): void => undefined;
  return {
    runs: () => current,
    changes: (told) => { changed = told; return () => { changed = () => undefined; }; },
    now: (runs) => { current = runs; changed(); },
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe('when a quiet file is told', () => {
  it('tells it once it has been quiet longer than any integration test has taken, then again each time as long again goes by, never ending the run', () => {
    const told: QuietNotice[] = [];
    const file = aFile();
    followQuiet(aSource([aRun(file)]), (notice) => told.push(notice), { after: QUIET_AFTER_MS });
    vi.advanceTimersByTime(QUIET_AFTER_MS - 1);
    expect(told).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(told.map((notice) => notice.line)).toEqual([quietLine(file, QUIET_AFTER_MS)]);
    vi.advanceTimersByTime(MIN);
    expect(told).toHaveLength(1);
    vi.advanceTimersByTime(QUIET_AFTER_MS - MIN);
    expect(told.map((notice) => notice.line)).toEqual([quietLine(file, QUIET_AFTER_MS), quietLine(file, 2 * QUIET_AFTER_MS)]);
    expect(QUIET_AFTER_MS).toBe(4 * MIN);
  });

  it('starts counting again the moment the file says something new', () => {
    const told: QuietNotice[] = [];
    const source = aSource([aRun(aFile())]);
    followQuiet(source, (notice) => told.push(notice), { after: QUIET_AFTER_MS });
    vi.advanceTimersByTime(QUIET_AFTER_MS);
    expect(told).toHaveLength(1);
    const moved = aFile({ changedAt: QUIET_AFTER_MS + 1, lastLine: 'next' });
    vi.advanceTimersByTime(1);
    source.now([aRun(moved)]);
    vi.advanceTimersByTime(QUIET_AFTER_MS - 1);
    expect(told).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(told.map((notice) => notice.line).at(-1)).toBe(quietLine(moved, 2 * QUIET_AFTER_MS + 1));
  });

  it('tells nothing more of a run once it has ended, and only of the runs in its group when it has one', () => {
    const told: QuietNotice[] = [];
    const source = aSource([aRun(aFile(), { pid: 7, group: 'mine' }), aRun(aFile(), { pid: 8, group: 'theirs' })]);
    followQuiet(source, (notice) => told.push(notice), { after: QUIET_AFTER_MS, group: 'mine' });
    vi.advanceTimersByTime(QUIET_AFTER_MS);
    expect(told.map((notice) => notice.run.pid)).toEqual([7]);
    source.now([]);
    vi.advanceTimersByTime(3 * QUIET_AFTER_MS);
    expect(told).toHaveLength(1);
  });

  it('tells nothing once it is stopped', () => {
    const told: QuietNotice[] = [];
    const follow = followQuiet(aSource([aRun(aFile())]), (notice) => told.push(notice), { after: QUIET_AFTER_MS });
    follow.stop();
    vi.advanceTimersByTime(3 * QUIET_AFTER_MS);
    expect(told).toEqual([]);
  });
});
