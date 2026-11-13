import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(BACKEND, '../..');
const BUSY = 'src/platform/testing/busy-until-stopped.ts';
const LONG_RUNNING = /^(src\/index|src\/worker-(engine|cluster|host))\.ts$/;
const folder = mkdtempSync(join(tmpdir(), 'process-starts-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const scripts = Object.entries((JSON.parse(readFileSync(join(BACKEND, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts)
  .map(([name, command]) => ({ where: `package.json ${name}`, words: command.split(' ') }));
const entrypoint = readFileSync(join(REPO, 'docker/entrypoint.sh'), 'utf8').split('\n')
  .map((line) => /^\s+([a-z|-]+)\) exec (.+?) ;;$/.exec(line))
  .filter((found): found is RegExpExecArray => found !== null)
  .map((found) => ({ where: `entrypoint.sh ${found[1]}`, words: found[2]!.split(' ') }));
const starts = [...scripts, ...entrypoint].filter((start) => !start.words.includes('watch') && start.words.some((word) => LONG_RUNNING.test(word)));

const stoppedWhileBusy = async (words: readonly string[], told: string): Promise<{ code: number | null; ranItsStop: boolean }> => {
  const [command, ...args] = words.map((word) => (LONG_RUNNING.test(word) ? BUSY : word));
  const child = spawn(command!, [...args, told], { cwd: BACKEND, stdio: 'ignore' });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  while (!existsSync(`${told}.started`)) await new Promise((done) => setTimeout(done, 20));
  child.kill('SIGTERM');
  const code = await exited;
  return { code, ranItsStop: existsSync(told) };
};

describe('every way Koala starts its backend and workers lets them stop on their own terms', () => {
  it('finds the backend and the three workers started by the package scripts and the image', () => {
    expect(starts.map((start) => start.where).sort()).toEqual([
      'entrypoint.sh backend', 'entrypoint.sh worker-cluster', 'entrypoint.sh worker-engine', 'entrypoint.sh worker-host',
      'package.json start', 'package.json start:worker', 'package.json start:worker:cluster', 'package.json start:worker:engine',
    ]);
  });

  it.each(starts.map((start) => [start.where, start.words] as const))('%s, stopped while busy, runs its own stop and exits cleanly', async (where, words) => {
    const result = await stoppedWhileBusy(words, join(folder, where.replace(/[^a-z0-9]+/gi, '-')));
    expect(result).toEqual({ code: 0, ranItsStop: true });
  });
});
