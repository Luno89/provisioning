import { spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHeldRun } from '../tiers/fixture-run/start.js';
import { watchQuiet } from './quiet-watch.js';
import { until, waiting } from './until.js';

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function aPlace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-watch-'));
  dirs.push(dir);
  return dir;
}

function watchedHeldRun(): { runs: string; printed: string; run: ReturnType<typeof startHeldRun> } {
  const place = aPlace();
  const runs = join(place, 'runs');
  const printed = join(place, 'terminal');
  const watch = watchQuiet({ after: 1500, out: openSync(printed, 'w'), env: { KOALA_TEST_RUNS: runs } });
  stops.push(watch.stop);
  return { runs, printed, run: startHeldRun(runs, watch.env) };
}

const QUIET = /^ {2}run\.held\.ts › a held run › says a line and is held: quiet \d+ s; last said: the line it said last$/gm;

describe('the quiet line gather, gate and ship print while a run they started has a file gone quiet', () => {
  it('names the quiet file, what it is in and what it said last, says it again as the quiet goes on, and never stops the run', async () => {
    const { runs, printed, run } = watchedHeldRun();
    const other = startHeldRun(runs, { FIXTURE_SAYS: 'a run someone else started' });
    await until('the quiet line to be printed twice for the held file', async () => {
      const lines = readFileSync(printed, 'utf8').match(QUIET) ?? [];
      return lines.length >= 2 ? lines : waiting(`${lines.length} printed so far`);
    }, run.stopped);
    expect(readFileSync(printed, 'utf8')).not.toContain('a run someone else started');
    for (const held of [run, other]) { held.release('test'); held.release('after'); }
    expect(await run.ended).toBe(0);
    expect(await other.ended).toBe(0);
  });

  it('prints the quiet line even while the process that started the watch is busy in a synchronous call, as gather is while its tier runs', async () => {
    const { printed, run } = watchedHeldRun();
    const waited = spawnSync('sh', ['-c', 'until grep -q "quiet [0-9]* s; last said: the line it said last" "$1"; do sleep 0.2; done', 'sh', printed]);
    expect(waited.status).toBe(0);
    expect(readFileSync(printed, 'utf8')).toMatch(QUIET);
    run.release('test');
    run.release('after');
    expect(await run.ended).toBe(0);
  });
});
