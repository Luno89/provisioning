import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liveRuns, type RunningFile } from '../lib/test-runs.js';
import { until } from '../lib/until.js';
import { CHECKOUT, startHeldRun } from './fixture-run/start.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function aPlace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'test-runs-'));
  dirs.push(dir);
  return dir;
}

const runningIn = (runs: string, pid: number): RunningFile | undefined => {
  const run = liveRuns(runs).find((one) => one.pid === pid);
  return run ? Object.values(run.files)[0] : undefined;
};

describe('the status every test run keeps while it runs', () => {
  it('names the run\'s checkout and workspace, the file and test running, and the last line it said, and is gone once the run ends', async () => {
    const runs = aPlace();
    const run = startHeldRun(runs);
    const inTest = await until('the held run to show its held test and what it said', async () => {
      const file = runningIn(runs, run.pid);
      return file?.doing === 'a held run › says a line and is held' && file.lastLine === 'the line it said last' ? file : undefined;
    }, run.stopped);
    expect(liveRuns(runs).find((one) => one.pid === run.pid)).toMatchObject({ checkout: CHECKOUT, workspace: 'tests/tiers/fixture-run' });
    expect(inTest.file).toBe('tests/tiers/fixture-run/run.held.ts');

    run.release('test');
    const inHook = await until('the held run to show its afterAll and what it said there', async () => {
      const file = runningIn(runs, run.pid);
      return file?.doing === 'afterAll' && file.lastLine?.startsWith('still waiting') ? file : undefined;
    }, run.stopped);
    expect(inHook.lastLine).toBe('still waiting for the fixture to be let go (it is held)');

    run.release('after');
    expect(await run.ended).toBe(0);
    expect(readdirSync(runs)).toEqual([]);
  });

  it('carries the group of whoever started the run, so they can watch only their own', async () => {
    const runs = aPlace();
    const run = startHeldRun(runs, { KOALA_TEST_GROUP: 'gather-1' });
    const status = await until('the grouped run to be live', async () => liveRuns(runs).find((one) => one.pid === run.pid), run.stopped);
    expect(status.group).toBe('gather-1');
    run.release('test');
    run.release('after');
    expect(await run.ended).toBe(0);
  });
});
