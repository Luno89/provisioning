import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const BACKEND = resolve(import.meta.dirname, '../../..');
const CONFIG = join(import.meta.dirname, 'run-ends/vitest.config.ts');
const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    await chmod(join(folder, 'mongo'), 0o700).then(() => undefined, (gone: Error) => gone.message);
    await rm(folder, { recursive: true, force: true });
  }
});

function vitestRun(tmp: string): Promise<{ code: number | null; said: string }> {
  const child = spawn(process.execPath, [join(BACKEND, '../../node_modules/vitest/vitest.mjs'), 'run', '--config', CONFIG], { cwd: BACKEND, env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  child.stdout.on('data', (chunk: Buffer) => { said += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { said += chunk.toString(); });
  return new Promise((done) => child.once('close', (code) => done({ code, said })));
}

async function own(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'koala-run-ends-'));
  folders.push(folder);
  return folder;
}

describe('a test run whose Mongo is gone', () => {
  it('ends at once when the test Mongo cannot start, saying why and the room on its disk', async () => {
    const tmp = await own();
    await mkdir(join(tmp, 'mongo'));
    await chmod(join(tmp, 'mongo'), 0o500);
    const run = await vitestRun(tmp);
    expect(run.code).toBe(1);
    expect(run.said).toMatch(/the test Mongo could not start: .+\(disk where it writes: .+\/mongo, [0-9.]+ [KMGT]?B free\)/s);
  });

  it('ends with why when the test Mongo stops while a test waits on it', async () => {
    const run = await vitestRun(await own());
    expect(run.code).toBe(1);
    expect(run.said).toMatch(/the test Mongo ended while the run needed it: mongod exited with 0 .*\(disk where it writes: .+\/mongo, [0-9.]+ [KMGT]?B free\)/s);
  });
});
