import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHeldRun } from '../tiers/fixture-run/start.js';
import { here } from './processes.js';
import { watchQuiet } from './quiet-watch.js';
import { until, waiting } from './until.js';

const dirs: string[] = [];
const fds: number[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const fd of fds.splice(0)) closeSync(fd);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function aPlace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-watch-'));
  dirs.push(dir);
  return dir;
}

function watchedHeldRun(place: string, out: number): { runs: string; run: ReturnType<typeof startHeldRun> } {
  const runs = join(place, 'runs');
  const watch = watchQuiet({ after: 1500, out, env: { KOALA_TEST_RUNS: runs } });
  stops.push(watch.stop);
  return { runs, run: startHeldRun(runs, watch.env) };
}

async function aPipe(place: string): Promise<{ read: number; write: number; written: () => void }> {
  const path = join(place, 'terminal');
  const made = await here.run({ command: 'mkfifo', args: [path] });
  expect(made).toMatchObject({ code: 0 });
  const keptOpen = openSync(path, 'r+');
  const read = openSync(path, 'r');
  const write = openSync(path, 'w');
  fds.push(read);
  return { read, write, written: () => { closeSync(write); closeSync(keptOpen); } };
}

function readUntilSaid(fd: number, line: RegExp): string {
  const chunk = Buffer.alloc(4096);
  let said = '';
  for (;;) {
    const got = readSync(fd, chunk);
    if (got === 0) throw new Error(`the watch ended without printing the quiet line; it printed ${said ? `only: ${said}` : 'nothing'}`);
    said += chunk.toString('utf8', 0, got);
    if (line.test(said)) return said;
  }
}

const QUIET = /^ {2}run\.held\.ts › a held run › says a line and is held: quiet \d+ s; last said: the line it said last$/gm;

describe('the quiet line gather, gate and ship print while a run they started has a file gone quiet', () => {
  it('names the quiet file, what it is in and what it said last, says it again as the quiet goes on, and never stops the run', async () => {
    const place = aPlace();
    const printed = join(place, 'terminal');
    const { runs, run } = watchedHeldRun(place, openSync(printed, 'w'));
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
    const place = aPlace();
    const pipe = await aPipe(place);
    const { run } = watchedHeldRun(place, pipe.write);
    pipe.written();
    expect(readUntilSaid(pipe.read, new RegExp(QUIET.source, 'm'))).toMatch(QUIET);
    run.release('test');
    run.release('after');
    expect(await run.ended).toBe(0);
  });
});
