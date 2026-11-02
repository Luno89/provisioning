import { describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { machineLock, resolveFrom } from './machine-lock.mjs';

const run = promisify(execFile);
const BUNDLER = fileURLToPath(new URL('./bundle-machine.mjs', import.meta.url));
const OWN = { name: 'koala-machine', version: '1.0.0', engines: { node: '>=20' } };
const at = (version, extra = {}) => ({ version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`, integrity: `sha512-${version}`, ...extra });

const repoLock = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'repo', workspaces: ['apps/*'] },
    'apps/agent': { version: '1.0.0', dependencies: { worker: '^1', sdk: '^1', tool: '^1' } },
    'node_modules/agent': { link: true, resolved: 'apps/agent' },
    'node_modules/worker': at('1.2.0', { dev: true, dependencies: { long: '^5', zod: '^3' }, optionalDependencies: { 'native-linux': '1', 'native-darwin': '1' }, peerDependencies: { peerneed: '1', peermaybe: '1' }, peerDependenciesMeta: { peermaybe: { optional: true } } }),
    'node_modules/worker/node_modules/long': at('4.0.0'),
    'node_modules/long': at('5.3.2'),
    'node_modules/zod': at('3.25.0', { dev: true }),
    'node_modules/native-linux': at('1.0.0', { optional: true, os: ['linux'] }),
    'node_modules/native-darwin': at('1.0.0', { optional: true, os: ['darwin'] }),
    'node_modules/peerneed': at('1.0.0', { peer: true }),
    'node_modules/peermaybe': at('1.0.0'),
    'apps/agent/node_modules/sdk': at('1.8.0', { dependencies: { long: '^5' } }),
    'node_modules/sdk': at('0.9.0'),
    'node_modules/tool': at('2.0.0', { dependencies: { native: '1' }, optionalDependencies: { native: '1' } }),
    'node_modules/native': at('1.0.0', { optional: true }),
    'node_modules/unused': at('9.9.9'),
  },
};

describe('the machine agent\'s lockfile, from the repository\'s own', () => {
  it('resolves a package the way node does, from the nearest node_modules up', () => {
    expect(resolveFrom(repoLock.packages, 'apps/agent', 'sdk')).toBe('apps/agent/node_modules/sdk');
    expect(resolveFrom(repoLock.packages, 'apps/agent', 'worker')).toBe('node_modules/worker');
    expect(resolveFrom(repoLock.packages, 'node_modules/worker', 'long')).toBe('node_modules/worker/node_modules/long');
    expect(resolveFrom(repoLock.packages, 'apps/agent/node_modules/sdk', 'long')).toBe('node_modules/long');
    expect(resolveFrom(repoLock.packages, 'node_modules/worker', 'nothing')).toBeUndefined();
  });

  it('keeps exactly the versions the workspace resolves, laid out from the workspace, with nothing it does not need', () => {
    const lock = machineLock(repoLock, 'apps/agent', ['worker', 'sdk', 'tool'], OWN);
    expect(lock.packages['']).toEqual({ name: 'koala-machine', version: '1.0.0', engines: { node: '>=20' }, dependencies: { sdk: '1.8.0', tool: '2.0.0', worker: '1.2.0' } });
    expect(Object.keys(lock.packages)).toEqual([
      '', 'node_modules/long', 'node_modules/native', 'node_modules/native-darwin', 'node_modules/native-linux', 'node_modules/peerneed',
      'node_modules/sdk', 'node_modules/tool', 'node_modules/worker', 'node_modules/worker/node_modules/long', 'node_modules/zod',
    ]);
    expect(lock.packages['node_modules/sdk'].version).toBe('1.8.0');
    expect(lock.packages['node_modules/worker/node_modules/long'].version).toBe('4.0.0');
    expect(lock.packages['node_modules/long'].version).toBe('5.3.2');
  });

  it('drops the repository\'s dev and peer marks, and marks optional only what nothing needs', () => {
    const { packages } = machineLock(repoLock, 'apps/agent', ['worker', 'sdk', 'tool'], OWN);
    expect(packages['node_modules/worker'].dev).toBeUndefined();
    expect(packages['node_modules/zod'].dev).toBeUndefined();
    expect(packages['node_modules/peerneed'].peer).toBeUndefined();
    expect(packages['node_modules/native-linux']).toMatchObject({ optional: true, os: ['linux'] });
    expect(packages['node_modules/native'].optional).toBeUndefined();
    expect(packages['node_modules/peermaybe']).toBeUndefined();
  });

  it('is the same whatever order the repository lists its packages in', () => {
    const reversed = { ...repoLock, packages: Object.fromEntries(Object.entries(repoLock.packages).reverse()) };
    expect(JSON.stringify(machineLock(reversed, 'apps/agent', ['worker', 'sdk', 'tool'], OWN))).toBe(JSON.stringify(machineLock(repoLock, 'apps/agent', ['worker', 'sdk', 'tool'], OWN)));
  });

  it('refuses a package the repository does not have, and a layout it cannot keep', () => {
    expect(() => machineLock(repoLock, 'apps/agent', ['missing'], OWN)).toThrow(/missing, which apps\/agent needs, is not in package-lock.json/);
    const clash = { ...repoLock, packages: { ...repoLock.packages, 'apps/agent/node_modules/zod': at('4.0.0') } };
    expect(() => machineLock(clash, 'apps/agent', ['worker', 'zod'], OWN)).toThrow(/would both be node_modules\/zod/);
  });
});

describe('the machine agent\'s bundle', () => {
  it('is the same bytes however often, wherever and whenever it is built', async () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'machine-bundle-'));
    try {
      await run(process.execPath, [BUNDLER, path.join(work, 'one')], { cwd: path.dirname(BUNDLER) });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await run('sh', ['-c', `umask 077 && "${process.execPath}" "${BUNDLER}" "${path.join(work, 'two')}"`], { cwd: os.tmpdir() });
      const one = readFileSync(path.join(work, 'one', 'machine-agent.tgz'));
      const two = readFileSync(path.join(work, 'two', 'machine-agent.tgz'));
      expect(two.equals(one)).toBe(true);
      expect(readFileSync(path.join(work, 'one', 'machine-agent.tgz.sha256'), 'utf8')).toBe(readFileSync(path.join(work, 'two', 'machine-agent.tgz.sha256'), 'utf8'));
      expect([...one.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
      const listed = execFileSync('tar', ['-tvzf', path.join(work, 'one', 'machine-agent.tgz'), '--utc'], { encoding: 'utf8' }).trim().split('\n');
      expect(listed.map((line) => line.split(/\s+/).at(-1))).toEqual(['./', './agent.mjs', './package-lock.json', './package.json']);
      for (const line of listed) {
        expect(line).toMatch(/^[d-]rw[x-]r-[x-]r-[x-] 0\/0 .* 1970-01-01 00:00 /);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
