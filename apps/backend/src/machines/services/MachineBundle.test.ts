import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Processes } from '../../platform/lib/processes.js';
import { MachineBundle } from './MachineBundle.js';

let dir: string;
let processes: ReturnType<typeof mock<Processes>>;

const printed = (stdout: string) => ({ code: 0, stdout, stderr: '' });
const building = (outDir: string, cwd: string) => ({ command: process.execPath, args: [`${cwd}/apps/local-agent/scripts/bundle-machine.mjs`, outDir], cwd });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bundle-'));
  processes = mock<Processes>();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the machine agent bundle', () => {
  it('builds the bundle once, however often it is asked for, and names the tarball the build printed last', async () => {
    processes.run.mockResolvedValue(printed('building…\n/out/machine-agent.tgz\n'));
    const bundle = new MachineBundle('/repo', '/out', processes);
    expect(await bundle.path()).toBe('/out/machine-agent.tgz');
    expect(await bundle.path()).toBe('/out/machine-agent.tgz');
    expect(processes.run).toHaveBeenCalledTimes(1);
    expect(processes.run).toHaveBeenCalledWith(building('/out', '/repo'));
  });

  it('puts the bundle under the agent\'s dist folder when told no other', async () => {
    processes.run.mockResolvedValue(printed('/x.tgz'));
    await new MachineBundle('/repo', undefined, processes).path();
    expect(processes.run).toHaveBeenCalledWith(building('/repo/apps/local-agent/dist', '/repo'));
  });

  it('reads its checksum from beside the tarball', async () => {
    const tarball = path.join(dir, 'machine-agent.tgz');
    await writeFile(`${tarball}.sha256`, `${'ab'.repeat(32)}  machine-agent.tgz\n`);
    processes.run.mockResolvedValue(printed(`${tarball}\n`));
    expect(await new MachineBundle('/repo', dir, processes).sha256()).toBe('ab'.repeat(32));
  });

  it('says why the build failed, with what the build printed on its error output, and builds again the next time it is asked', async () => {
    processes.run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'esbuild: cannot find module\n' });
    const bundle = new MachineBundle('/repo', '/out', processes);
    await expect(bundle.path()).rejects.toThrow('the machine agent could not be built: esbuild: cannot find module');
    processes.run.mockResolvedValueOnce(printed('/out/machine-agent.tgz'));
    expect(await bundle.path()).toBe('/out/machine-agent.tgz');
    expect(processes.run).toHaveBeenCalledTimes(2);
  });

  it('falls back to the error\'s own message when the build printed nothing', async () => {
    processes.run.mockRejectedValue(new Error('spawn node ENOENT'));
    await expect(new MachineBundle('/repo', '/out', processes).sha256()).rejects.toThrow('the machine agent could not be built: spawn node ENOENT');
  });
});
