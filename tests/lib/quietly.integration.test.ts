import { spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { until, waiting } from './until.js';
import { freshPlaces } from './fresh-places.js';

const QUIETLY = resolve(import.meta.dirname, '..', '..', 'scripts', 'quietly.sh');

const aPlace = freshPlaces('quietly-');

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
    await until('the step\'s first line in the file while it still runs', async () => { const written = readFileSync(out, 'utf8'); return written.includes('pulling temporal') ? true : waiting(`the file holds ${written.length} characters`); }, async () => stopped());
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
