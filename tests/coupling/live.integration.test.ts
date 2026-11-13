import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liveProcesses, sample } from './live.js';

const HOOK = resolve(import.meta.dirname, 'live-hook.mjs');
const TSX = resolve(import.meta.dirname, '..', '..', 'node_modules', '.bin', 'tsx');

let place = '';
let watcher: ChildProcess | undefined;
afterEach(() => {
  if (watcher?.pid) process.kill(-watcher.pid, 'SIGKILL');
  watcher = undefined;
  if (place) rmSync(place, { recursive: true, force: true });
});

const until = async <T>(found: () => T | undefined): Promise<T> => {
  for (;;) {
    const value = found();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
};

describe('the hook in a process run as Koala\'s pods run theirs, under tsx watch from a relative entry', () => {
  it('answers the sampler, and once the watcher restarts it, answers again under its new pid while the old one is waited on no more', async () => {
    place = mkdtempSync(join(tmpdir(), 'coupling-live-hook-'));
    const app = join(place, 'app', 'apps', 'backend');
    mkdirSync(join(app, 'src'), { recursive: true });
    const entry = join(app, 'src', 'index.ts');
    writeFileSync(entry, 'const kept: number[] = [];\nsetInterval(() => { kept.push(kept.length); }, 1000);\n');
    const live = join(place, 'live');
    mkdirSync(join(live, 'raw'), { recursive: true });
    watcher = spawn(TSX, ['watch', 'src/index.ts'], {
      cwd: app,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, COUPLING_LIVE_DIR: live, NODE_V8_COVERAGE: join(live, 'raw'), NODE_OPTIONS: `--enable-source-maps --import ${HOOK}` },
    });
    const first = await until(() => liveProcesses(live)[0]);
    await sample('one', live);
    expect(readdirSync(join(live, 'raw', 'startup')).some((name) => name.startsWith(`coverage-${first}-`))).toBe(true);

    writeFileSync(entry, 'const kept: string[] = [];\nsetInterval(() => { kept.push(String(kept.length)); }, 1000);\n');
    const second = await until(() => liveProcesses(live).find((pid) => pid !== first));
    await until(() => (liveProcesses(live).includes(first) ? undefined : true));
    await sample('two', live);
    await sample('three', live);
    expect(liveProcesses(live)).toEqual([second]);
    expect(readdirSync(join(live, 'raw', 'startup')).filter((name) => name.endsWith('.json')).map((name) => name.split('-')[1])).toEqual([String(second)]);
    expect(readdirSync(join(live, 'raw', 'three')).some((name) => name.startsWith(`coverage-${second}-`))).toBe(true);
    expect(existsSync(join(live, 'pids', String(first)))).toBe(true);
  }, 60_000);
});
