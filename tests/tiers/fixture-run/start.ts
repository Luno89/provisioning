import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const CHECKOUT = resolve(import.meta.dirname, '..', '..', '..');
const VITEST = join(CHECKOUT, 'node_modules', '.bin', 'vitest');
const HERE = import.meta.dirname;

export interface HeldRun {
  pid: number;
  output: () => string;
  release: (hold: 'test' | 'after') => void;
  ended: Promise<number | null>;
  stopped: () => Promise<string | undefined>;
}

export function startHeldRun(runs: string, env: Record<string, string> = {}): HeldRun {
  const held = mkdtempSync(join(tmpdir(), 'held-run-'));
  const child = spawn(VITEST, ['run', '--config', join(HERE, 'vitest.config.ts'), '--root', HERE], {
    cwd: HERE,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', KOALA_TEST_RUNS: runs, FIXTURE_HELD_IN: held, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  let endedWith: number | null | undefined;
  const ended = new Promise<number | null>((done) => child.on('exit', (code) => { endedWith = code; done(code); }));
  return {
    pid: child.pid!,
    output: () => output,
    release: (hold) => writeFileSync(join(held, hold), ''),
    ended,
    stopped: async () => (endedWith === undefined ? undefined : `the held run ended (${endedWith}): ${output.slice(-2000)}`),
  };
}
