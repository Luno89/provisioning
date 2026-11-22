import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { here } from '../lib/processes.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const FIXTURE = join(import.meta.dirname, 'fixture-leaves');

const running = (pid: number): boolean => {
  const stat = `/proc/${pid}/stat`;
  if (!existsSync(stat)) return false;
  const text = readFileSync(stat, 'utf8');
  return text.slice(text.lastIndexOf(')') + 2, text.lastIndexOf(')') + 3) !== 'Z';
};

describe('a test file that leaves a program of its own running', () => {
  it('fails, naming each program it left after its own afterAll ran, and none of them outlives it', async () => {
    const run = await here.run({ command: join(CHECKOUT, 'node_modules', '.bin', 'vitest'), args: ['run', '--config', join(FIXTURE, 'vitest.config.ts'), '--root', FIXTURE], cwd: FIXTURE, env: { CI: '1', FORCE_COLOR: '0' } });
    const said = `${run.stdout}${run.stderr}`;
    expect(run.code, said).toBe(1);
    const left = Number(/this file left 1 program of its own running after its last afterAll, now killed: (\d+) sleep 600/.exec(said)?.[1]);
    expect(left, said).toBeGreaterThan(0);
    expect(said, 'the program its afterAll ended is not named').not.toMatch(/sleep 601/);
    expect(running(left), `sleep ${left} outlived its run`).toBe(false);
  });
});
