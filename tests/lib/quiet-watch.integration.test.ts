import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHeldRun } from '../tiers/fixture-run/start.js';
import { watchQuiet } from './quiet-watch.js';
import { until } from './until.js';

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

const QUIET = /^ {2}run\.held\.ts › a held run › says a line and is held: quiet \d+ s; last said: the line it said last$/gm;

describe('the quiet line gather, gate and ship print while a run they started has a file gone quiet', () => {
  it('names the quiet file, what it is in and what it said last, says it again as the quiet goes on, and never stops the run', async () => {
    const place = aPlace();
    const runs = join(place, 'runs');
    const printed = join(place, 'terminal');
    const watch = watchQuiet({ after: 1500, out: openSync(printed, 'w'), env: { KOALA_TEST_RUNS: runs } });
    stops.push(watch.stop);
    const run = startHeldRun(runs, watch.env);
    const other = startHeldRun(runs, { FIXTURE_SAYS: 'a run someone else started' });
    await until('the quiet line to be printed twice for the held file', async () => {
      const lines = readFileSync(printed, 'utf8').match(QUIET) ?? [];
      return lines.length >= 2 ? lines : undefined;
    }, run.stopped);
    expect(readFileSync(printed, 'utf8')).not.toContain('a run someone else started');
    for (const held of [run, other]) { held.release('test'); held.release('after'); }
    expect(await run.ended).toBe(0);
    expect(await other.ended).toBe(0);
  });
});
