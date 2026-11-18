import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { until } from './until.js';

const QUIETLY = resolve(import.meta.dirname, '..', '..', 'scripts', 'quietly.sh');

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function aPlace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quietly-'));
  dirs.push(dir);
  return dir;
}

function quietlyToFile(dir: string, step: string): { out: string; ended: Promise<number | null>; stopped: () => string | undefined } {
  const out = join(dir, 'dev-stack.log');
  const fd = openSync(out, 'w');
  const run = spawn('bash', ['-c', `set -euo pipefail; . "${QUIETLY}"; quietly sh -c '${step}'`], { stdio: ['ignore', fd, fd] });
  let stoppedWith: string | undefined;
  const ended = new Promise<number | null>((done) => run.on('exit', (code) => { stoppedWith = `the step ended (${code}): ${readFileSync(out, 'utf8')}`; done(code); }));
  return { out, ended, stopped: () => stoppedWith };
}

describe('a dev step\'s output when npm run dev writes to a file, as under ship', () => {
  it('shows each line of the step while it runs, without its colours', async () => {
    const dir = aPlace();
    const go = join(dir, 'go');
    const { out, ended, stopped } = quietlyToFile(dir, `printf "\\033[1mpulling temporal\\033[0m\\n"; until [ -e "${go}" ]; do sleep 0.1; done; printf "extracting 10%%\\rextracting 100%%\\n\\ndone\\n"`);
    await until('the step\'s first line in the file while it still runs', async () => readFileSync(out, 'utf8').includes('pulling temporal'), async () => stopped());
    writeFileSync(go, '');
    expect(await ended).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('    pulling temporal\n    extracting 10%\n    extracting 100%\n    done\n');
  });

  it('shows a failing step\'s lines once and ends with its code', async () => {
    const dir = aPlace();
    const { out, ended } = quietlyToFile(dir, 'echo "Error: the port is taken"; exit 3');
    expect(await ended).toBe(3);
    expect(readFileSync(out, 'utf8')).toBe('    Error: the port is taken\n');
  });
});
