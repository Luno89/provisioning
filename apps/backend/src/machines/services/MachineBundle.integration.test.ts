import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineBundle } from './MachineBundle.js';

const REPO = path.resolve(process.cwd(), '../..');
const made: string[] = [];
const folder = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'machine-bundle-'));
  made.push(dir);
  return dir;
};
afterEach(async () => { for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('the machine agent bundle, built by the real build', () => {
  it('builds the agent once into the folder it is given, names the tarball, and reads the checksum that is the tarball\'s own', async () => {
    const out = await folder();
    const bundle = new MachineBundle(REPO, out);
    const [first, second] = await Promise.all([bundle.path(), bundle.path()]);
    expect([first, second]).toEqual([path.join(out, 'machine-agent.tgz'), path.join(out, 'machine-agent.tgz')]);
    const sha = await bundle.sha256();
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update(await readFile(first)).digest('hex')).toBe(sha);
    expect(await bundle.path()).toBe(first);
  }, 120_000);

  it('says why the build failed, in the build\'s own words, and builds again the next time it is asked', async () => {
    const root = await folder();
    const out = await folder();
    const bundle = new MachineBundle(root, out);
    await expect(bundle.path()).rejects.toThrow(/^the machine agent could not be built: .*bundle-machine\.mjs/s);
    await mkdir(path.join(root, 'apps/local-agent/scripts'), { recursive: true });
    const tarball = path.join(out, 'machine-agent.tgz');
    await writeFile(path.join(root, 'apps/local-agent/scripts/bundle-machine.mjs'), `import { writeFile } from 'node:fs/promises';\nawait writeFile(${JSON.stringify(tarball)}, 'bytes');\nawait writeFile(${JSON.stringify(`${tarball}.sha256`)}, 'ab'.repeat(32) + '  machine-agent.tgz\\n');\nconsole.log('building…');\nconsole.log(${JSON.stringify(tarball)});\n`);
    expect(await bundle.path()).toBe(tarball);
    expect(await bundle.sha256()).toBe('ab'.repeat(32));
  });
});
