import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutPathOf, cmdlineOf, entriesOf, liveProcesses, measuringProblem, ranIn, resolvedArgs, sample, type CmdlineOf, type RawCoverage } from './live.js';

const ENTRY = '/home/me/provisioning/apps/backend/src/worker-cluster.ts';
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function liveDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'coupling-live-'));
  mkdirSync(join(dir, 'pids'), { recursive: true });
  mkdirSync(join(dir, 'raw'), { recursive: true });
  return dir;
}

const listed = (pid: number, entry = ENTRY, cwd?: string) => writeFileSync(join(dir, 'pids', String(pid)), cwd === undefined ? entry : `${entry}\n${cwd}`);

describe('which of the dev stack\'s processes the sampler waits for', () => {
  it('reads this very process\'s command line with its arguments as full paths, as the hook records its entry', () => {
    expect(cmdlineOf(process.pid)).toContain(process.execPath);
    expect(cmdlineOf(2 ** 22 + 1)).toBeUndefined();
  });

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
    expect(readdirSync(join(dir, 'pids')).sort()).toEqual(['101', '202', '303']);
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

  it('takes a process in Koala\'s pods, whose working folder the host may not read, by the folder its hook recorded, and names its entry under the pods\' source', () => {
    liveDir();
    const podEntry = '/app/apps/backend/src/index.ts';
    listed(4242, podEntry, '/app/apps/backend');
    listed(4343, podEntry);
    const args = ['/usr/local/bin/node', '--require', '/app/node_modules/tsx/dist/preflight.cjs', 'src/index.ts'];
    const read: CmdlineOf = (_pid, cwd) => resolvedArgs(args, cwd);
    expect(liveProcesses(dir, read)).toEqual([4242]);
    expect(entriesOf(dir, read)).toEqual([podEntry]);
  });
});

describe('what ship asks of the processes measured', () => {
  it('refuses a stack measuring nothing, and one measuring root and the hub but not Koala\'s pods', () => {
    expect(measuringProblem([])).toMatch(/COUPLING_LIVE=1 npm run dev/);
    expect(measuringProblem([ENTRY])).toMatch(/not your Koala's pods/);
    expect(measuringProblem([ENTRY, '/app/apps/backend/src/worker-engine.ts'])).toBeUndefined();
  });
});

describe('what Koala\'s pods ran, counted as the checkout\'s own files', () => {
  it('maps the pods\' source folder onto the checkout and leaves every other path as it is', () => {
    expect(checkoutPathOf('/app/apps/backend/src/index.ts', '/home/me/provisioning')).toBe('/home/me/provisioning/apps/backend/src/index.ts');
    expect(checkoutPathOf('/application/x.ts', '/home/me/provisioning')).toBe('/application/x.ts');
    expect(checkoutPathOf('/home/me/provisioning/apps/backend/src/index.ts', '/home/me/provisioning')).toBe('/home/me/provisioning/apps/backend/src/index.ts');
  });

  it('gives a pod\'s coverage and the host\'s of the same file the same path in the checkout', () => {
    const script = (url: string) => ({
      url,
      functions: [{ functionName: 'serve', ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] }],
    });
    const map = { lineLengths: [20], data: { version: 3 as const, sources: ['index.ts'], names: [], mappings: 'AAAA' } };
    const pod = 'file:///app/apps/backend/src/index.ts';
    const host = 'file:///home/me/provisioning/apps/backend/src/index.ts';
    const library = 'file:///app/node_modules/x/index.js';
    const coverage: RawCoverage = {
      result: [script(pod), script(host), script(library)],
      'source-map-cache': { [pod]: map, [host]: map, [library]: map },
    };
    const ran = ranIn(coverage, '/home/me/provisioning');
    expect(Object.keys(ran)).toEqual(['apps/backend/src/index.ts']);
    const range = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 }, count: 1, fn: 'serve' };
    expect(ran['apps/backend/src/index.ts']).toEqual([range, range]);
  });
});
