import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKOUT, startHeldRun } from '../tiers/fixture-run/start.js';
import { liveRuns } from './test-runs.js';
import { until, waiting } from './until.js';
import { freshPlaces } from './fresh-places.js';

const aPlace = freshPlaces('test-runs-');

const status = (runs: string) => spawnSync('npm', ['run', '--silent', 'test:status'], { cwd: CHECKOUT, env: { ...process.env, KOALA_TEST_RUNS: runs }, encoding: 'utf8' });

describe('npm run test:status', () => {
  it('prints every live run on this machine: its checkout, workspace, the files running and how long each has been quiet', async () => {
    const runs = aPlace();
    const one = startHeldRun(runs);
    const two = startHeldRun(runs);
    await until('both held runs to be in their held test', async () => {
      const held = liveRuns(runs).filter((run) => Object.values(run.files).some((file) => file.lastLine === 'the line it said last'));
      return held.length === 2 ? held : waiting(`${held.length} of 2 held, ${liveRuns(runs).length} live`);
    }, async () => (await one.stopped()) ?? (await two.stopped()));

    const printed = status(runs);
    expect(printed.status).toBe(0);
    const lines = printed.stdout.trim().split('\n');
    expect(lines[0]).toBe('2 test runs live on this machine');
    for (const run of [one, two]) {
      const at = lines.findIndex((line) => line.startsWith(`${CHECKOUT} · tests/tiers/fixture-run · pid ${run.pid} · running `));
      expect(at).toBeGreaterThan(0);
      expect(lines[at]).toMatch(/· 1 file running$/);
      expect(lines[at + 1]).toMatch(/^ {2}tests\/tiers\/fixture-run\/run\.held\.ts › a held run › says a line and is held: quiet \d+ (s|min); last said: the line it said last$/);
    }

    for (const run of [one, two]) { run.release('test'); run.release('after'); }
    expect(await one.ended).toBe(0);
    expect(await two.ended).toBe(0);
    const after = status(runs);
    expect(after.status).toBe(0);
    expect(after.stdout.trim()).toBe('no test runs are live on this machine');
  });

  it('leaves out, and clears away, the status a run left behind when its process was killed', () => {
    const runs = aPlace();
    const gone = spawnSync('true').pid;
    const left = join(runs, `${gone}.json`);
    writeFileSync(left, JSON.stringify({ pid: gone, checkout: CHECKOUT, workspace: 'apps/backend', startedAt: 0, files: {} }));
    const printed = status(runs);
    expect(printed.status).toBe(0);
    expect(printed.stdout.trim()).toBe('no test runs are live on this machine');
    expect(existsSync(left)).toBe(false);
  });
});
