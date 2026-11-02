import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockFn } from 'vitest-mock-extended';
import { MachineBundle, type BundleBuild } from './MachineBundle.js';

let dir: string;
let build: ReturnType<typeof mockFn<BundleBuild>>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bundle-'));
  build = mockFn<BundleBuild>();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the machine agent bundle', () => {
  it('builds the bundle once, however often it is asked for, and names the tarball the build printed last', async () => {
    build.mockResolvedValue({ stdout: 'building…\n/out/machine-agent.tgz\n' });
    const bundle = new MachineBundle('/repo', '/out', build);
    expect(await bundle.path()).toBe('/out/machine-agent.tgz');
    expect(await bundle.path()).toBe('/out/machine-agent.tgz');
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith({ script: '/repo/apps/local-agent/scripts/bundle-machine.mjs', outDir: '/out', cwd: '/repo' });
  });

  it('puts the bundle under the agent\'s dist folder when told no other', async () => {
    build.mockResolvedValue({ stdout: '/x.tgz' });
    await new MachineBundle('/repo', undefined, build).path();
    expect(build).toHaveBeenCalledWith({ script: '/repo/apps/local-agent/scripts/bundle-machine.mjs', outDir: '/repo/apps/local-agent/dist', cwd: '/repo' });
  });

  it('reads its checksum from beside the tarball', async () => {
    const tarball = path.join(dir, 'machine-agent.tgz');
    await writeFile(`${tarball}.sha256`, `${'ab'.repeat(32)}  machine-agent.tgz\n`);
    build.mockResolvedValue({ stdout: `${tarball}\n` });
    expect(await new MachineBundle('/repo', dir, build).sha256()).toBe('ab'.repeat(32));
  });

  it('says why the build failed, with what the build printed on its error output, and builds again the next time it is asked', async () => {
    build.mockRejectedValueOnce(Object.assign(new Error('Command failed: node bundle-machine.mjs'), { stderr: 'esbuild: cannot find module\n' }));
    const bundle = new MachineBundle('/repo', '/out', build);
    await expect(bundle.path()).rejects.toThrow('the machine agent could not be built: esbuild: cannot find module');
    build.mockResolvedValueOnce({ stdout: '/out/machine-agent.tgz' });
    expect(await bundle.path()).toBe('/out/machine-agent.tgz');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('falls back to the error\'s own message when the build printed nothing', async () => {
    build.mockRejectedValue(new Error('spawn node ENOENT'));
    await expect(new MachineBundle('/repo', '/out', build).sha256()).rejects.toThrow('the machine agent could not be built: spawn node ENOENT');
  });
});
