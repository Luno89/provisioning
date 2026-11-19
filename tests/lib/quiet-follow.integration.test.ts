import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHECKOUT, startHeldRun } from '../tiers/fixture-run/start.js';
import { freshPlaces } from './fresh-places.js';

const aPlace = freshPlaces('quiet-follow-');
const TSX = resolve(CHECKOUT, 'node_modules', '.bin', 'tsx');
const STATUS = resolve(import.meta.dirname, 'test-status.ts');

const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) if (child.exitCode === null) child.kill(); });

const started = (args: string[], runs: string): { child: ChildProcess; said: () => string; heard: (pattern: RegExp, count?: number) => Promise<string[]> } => {
  const child = spawn(TSX, [STATUS, ...args], { env: { ...process.env, KOALA_TEST_RUNS: runs }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let said = '';
  const listeners = new Set<() => void>();
  const tell = () => { for (const listener of listeners) listener(); };
  child.stdout!.on('data', (chunk: Buffer) => { said += chunk.toString(); tell(); });
  child.stderr!.on('data', (chunk: Buffer) => { said += chunk.toString(); tell(); });
  const heard = (pattern: RegExp, count = 1) => new Promise<string[]>((done, fail) => {
    const check = () => {
      const found = said.match(new RegExp(pattern.source, 'gm')) ?? [];
      if (found.length >= count) { listeners.delete(check); child.off('exit', ended); done(found); }
    };
    const ended = (code: number | null) => { listeners.delete(check); fail(new Error(`test:status ended (${code}) before it said ${pattern}: ${said}`)); };
    listeners.add(check);
    child.once('exit', ended);
    check();
  });
  return { child, said: () => said, heard };
};

describe('npm run test:status -- --follow, which tells whoever follows it the moment a test file goes quiet', () => {
  it('names the run and the quiet file as soon as it has been quiet past the limit, says it again while it stays quiet, and never stops the run', async () => {
    const runs = aPlace();
    const follow = started(['--follow', '--after', '1500'], runs);
    const run = startHeldRun(runs);
    const lines = await follow.heard(new RegExp(`^${CHECKOUT} · tests/tiers/fixture-run · pid ${run.pid} › run\\.held\\.ts › a held run › says a line and is held: quiet \\d+ s; last said: the line it said last$`), 2);
    expect(lines).toHaveLength(2);
    expect(await run.stopped()).toBeUndefined();
    run.release('test');
    run.release('after');
    expect(await run.ended).toBe(0);
    expect(follow.child.exitCode).toBeNull();
  });
});

describe('the quiet watch gather, gate and ship start beside a run', () => {
  it('ends the moment the process that started it is gone, as its pipe closes, with nothing left behind', async () => {
    const runs = aPlace();
    const watch = started(['watch', 'a-group', '1500'], runs);
    const ended = new Promise<number | null>((done) => watch.child.once('exit', done));
    watch.child.stdin!.end();
    expect(await ended).toBe(0);
  });
});
