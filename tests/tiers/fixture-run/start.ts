import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const CHECKOUT = resolve(import.meta.dirname, '..', '..', '..');
const VITEST = join(CHECKOUT, 'node_modules', '.bin', 'vitest');
const HERE = import.meta.dirname;

export interface HeldRun {
  pid: number;
  heard: (text: string) => Promise<void>;
  output: () => string;
  release: (hold: 'test' | 'after') => void;
  ended: Promise<number | null>;
  stopped: () => Promise<string | undefined>;
}

const live = new Set<number>();
let endsWithStarter = false;

const endWithStarter = (): void => {
  if (endsWithStarter) return;
  endsWithStarter = true;
  process.on('exit', () => {
    for (const group of live) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
    }
  });
};

export function startHeldRun(runs: string, env: Record<string, string> = {}): HeldRun {
  const held = mkdtempSync(join(tmpdir(), 'held-run-'));
  endWithStarter();
  const child = spawn(VITEST, ['run', '--config', join(HERE, 'vitest.config.ts'), '--root', HERE], {
    cwd: HERE,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', KOALA_TEST_RUNS: runs, FIXTURE_HELD_IN: held, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  live.add(child.pid!);
  let output = '';
  const listening = new Set<() => void>();
  const said = (chunk: Buffer) => { output += chunk.toString(); for (const listener of listening) listener(); };
  child.stdout.on('data', said);
  child.stderr.on('data', said);
  let endedWith: number | null | undefined;
  const ended = new Promise<number | null>((done) => child.on('exit', (code) => { endedWith = code; live.delete(child.pid!); done(code); }));
  const heard = (text: string): Promise<void> => new Promise((done, failed) => {
    const check = () => {
      if (output.includes(text)) { listening.delete(check); done(); } else if (endedWith !== undefined) { listening.delete(check); failed(new Error(`the held run ended (${endedWith}) before it said ${text}: ${output.slice(-2000)}`)); }
    };
    listening.add(check);
    void ended.then(check);
    check();
  });
  return {
    pid: child.pid!,
    heard,
    output: () => output,
    release: (hold) => writeFileSync(join(held, hold), ''),
    ended,
    stopped: async () => (endedWith === undefined ? undefined : `the held run ended (${endedWith}): ${output.slice(-2000)}`),
  };
}
