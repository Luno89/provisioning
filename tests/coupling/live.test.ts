import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liveProcesses, sample, type CmdlineOf } from './live.js';

const ENTRY = '/home/me/provisioning/apps/backend/src/worker-cluster.ts';
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function liveDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'coupling-live-'));
  mkdirSync(join(dir, 'pids'), { recursive: true });
  mkdirSync(join(dir, 'raw'), { recursive: true });
  return dir;
}

const listed = (pid: number, entry = ENTRY) => writeFileSync(join(dir, 'pids', String(pid)), entry);

describe('which of the dev stack\'s processes the sampler waits for', () => {
  it('takes a listed pid as the process it was only while its command line still names the entry it recorded', () => {
    liveDir();
    listed(101);
    listed(202);
    listed(303);
    const cmdlines: Record<number, string> = {
      101: `node --import tsx ${ENTRY}`,
      202: '/usr/lib/chromium/chromium --type=renderer',
    };
    const read: CmdlineOf = (pid) => cmdlines[pid];
    expect(liveProcesses(dir, read)).toEqual([101]);
    expect(readdirSync(join(dir, 'pids')).sort()).toEqual(['101']);
  });

  it('does not wait for a pid now held by another program\'s thread, which never answers, and finishes once the stack\'s own process has', async () => {
    liveDir();
    listed(101);
    listed(19808);
    const read: CmdlineOf = (pid) => (pid === 101 ? `node ${ENTRY}` : pid === 19808 ? 'chromium --type=utility' : undefined);
    const sampled = sample('suite', dir, read);
    const asked = await new Promise<string>((done) => {
      const look = () => {
        try {
          done(readFileSync(join(dir, 'request'), 'utf8'));
        } catch {
          setTimeout(look, 10);
        }
      };
      look();
    });
    writeFileSync(join(dir, 'pids', '101.taken'), asked);
    await sampled;
    expect(readdirSync(join(dir, 'raw')).sort()).toEqual(['startup', 'suite']);
  });
});
