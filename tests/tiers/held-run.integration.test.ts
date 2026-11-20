import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const TSX = join(CHECKOUT, 'node_modules', '.bin', 'tsx');
const STARTER = `
import { startHeldRun } from ${JSON.stringify(join(import.meta.dirname, 'fixture-run', 'start.ts'))};
const run = startHeldRun(process.argv[2]);
console.log(run.pid);
void run.heard('first line').then(() => process.exit(0));
`;

const places: string[] = [];
afterEach(() => { for (const place of places.splice(0)) rmSync(place, { recursive: true, force: true }); });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('a held fixture run', () => {
  it('ends, with every process it started, when the test process that started it ends without letting it go', async () => {
    const runs = mkdtempSync(join(tmpdir(), 'held-runs-'));
    places.push(runs);
    const starter = spawn(TSX, ['--eval', STARTER, runs], { cwd: CHECKOUT, stdio: ['ignore', 'pipe', 'inherit'] });
    let printed = '';
    starter.stdout.on('data', (chunk: Buffer) => { printed += chunk.toString(); });
    const code = await new Promise<number | null>((done) => starter.on('exit', done));
    const pid = Number(printed.trim().split('\n')[0]);

    expect(code).toBe(0);
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  });
});
