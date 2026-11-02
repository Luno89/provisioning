import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownBundle, ownVersion, placeOf, prepareBundle, swapBundle, versionSaid, type BundlePlace } from './agent-bundle.js';

const AGENT = `import { readFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url);
const read = (name) => { try { return readFileSync(new URL(name, dir), 'utf8'); } catch { return null; } };
if (process.argv[2] === 'version') console.log(JSON.stringify({ bundle: read('bundle.sha256')?.trim() ?? null, version: JSON.parse(read('package.json')).version }));
`;

function tarball(dir: string, version: string, agent = AGENT, dependencies: Record<string, string> = {}): { file: string; sha256: string } {
  const staging = path.join(dir, `staging-${version}`);
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, 'agent.mjs'), agent);
  writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'koala-machine', version, private: true, type: 'module', dependencies }));
  writeFileSync(path.join(staging, 'package-lock.json'), JSON.stringify({ name: 'koala-machine', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'koala-machine', version } } }));
  const file = path.join(dir, `agent-${version}.tgz`);
  execFileSync('tar', ['-czf', file, '-C', staging, '.']);
  return { file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
}

let work: string;
let place: BundlePlace;
let server: Server;
let served: string | undefined;
let url: string;

beforeEach(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), 'agent-bundle-'));
  place = placeOf(path.join(work, 'machine'));
  const running = tarball(work, '1.0.0');
  mkdirSync(place.dir);
  execFileSync('tar', ['-xzf', running.file, '-C', place.dir]);
  writeFileSync(path.join(place.dir, 'bundle.sha256'), `${running.sha256}\n`);
  served = undefined;
  server = createServer((request, response) => {
    if (request.url !== '/api/machines/agent.tgz' || !served) return response.writeHead(404).end('no');
    response.writeHead(200, { 'content-type': 'application/gzip' }).end(readFileSync(served));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/machines/agent.tgz`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
});

describe('the agent reads which bundle it runs', () => {
  it('from the bundle.sha256 and package.json beside it', () => {
    expect(ownBundle(place.dir)).toMatch(/^[0-9a-f]{64}$/);
    expect(ownVersion(place.dir)).toBe('1.0.0');
    expect(ownBundle(path.join(work, 'nowhere'))).toBeUndefined();
  });

  it('and understands what a started agent says about itself', () => {
    expect(versionSaid('noise\n{"bundle":"abc","version":"1.0.1"}\n')).toEqual({ bundle: 'abc', version: '1.0.1' });
    expect(versionSaid('Error: Cannot find module')).toBeUndefined();
  });
});

describe('a newer agent is made ready beside the running one', () => {
  it('downloads it, checks it is the one Koala named, installs it with npm ci and proves it starts', async () => {
    const next = tarball(work, '1.0.1');
    served = next.file;
    await prepareBundle({ place, bundle: next.sha256, url, node: process.execPath });
    expect(readFileSync(path.join(place.next, 'bundle.sha256'), 'utf8').trim()).toBe(next.sha256);
    expect(ownVersion(place.next)).toBe('1.0.1');
    expect(ownVersion(place.dir)).toBe('1.0.0');
  });

  it('refuses one that is not what Koala named, leaving nothing behind', async () => {
    served = tarball(work, '1.0.1').file;
    await expect(prepareBundle({ place, bundle: 'f'.repeat(64), url, node: process.execPath })).rejects.toThrow(/not the one it named/);
    expect(existsSync(place.next)).toBe(false);
    expect(ownVersion(place.dir)).toBe('1.0.0');
  });

  it('says so when Koala does not hand it over', async () => {
    await expect(prepareBundle({ place, bundle: 'f'.repeat(64), url, node: process.execPath })).rejects.toThrow(/Koala answered 404/);
    await expect(prepareBundle({ place, bundle: 'f'.repeat(64), url: 'http://127.0.0.1:9/api/machines/agent.tgz', node: process.execPath })).rejects.toThrow(/could not be downloaded/);
  });

  it('throws away one that does not start, and keeps the running agent', async () => {
    const broken = tarball(work, '1.0.2', 'throw new Error("broken build");\n');
    served = broken.file;
    await expect(prepareBundle({ place, bundle: broken.sha256, url, node: process.execPath })).rejects.toThrow(/broken build/);
    expect(existsSync(place.next)).toBe(false);
    expect(ownVersion(place.dir)).toBe('1.0.0');
  });

  it('throws away one whose packages npm cannot install', async () => {
    const unsynced = tarball(work, '1.0.3', AGENT, { 'left-pad': '1.3.0' });
    served = unsynced.file;
    await expect(prepareBundle({ place, bundle: unsynced.sha256, url, node: process.execPath })).rejects.toThrow(/npm ci failed: npm (ERR|error)/);
    expect(existsSync(place.next)).toBe(false);
  });

  it('says where there is no room for it', async () => {
    const next = tarball(work, '1.0.1');
    served = next.file;
    writeFileSync(path.join(work, 'blocker'), '');
    const blocked = { ...place, next: path.join(work, 'blocker', 'machine.next') };
    await expect(prepareBundle({ place: blocked, bundle: next.sha256, url, node: process.execPath })).rejects.toThrow(/no room for the new agent/);
  });
});

describe('the newer agent takes the running one\'s place', () => {
  it('moves the running one to .previous, so a person can go back by hand, and the new one in', async () => {
    const next = tarball(work, '1.0.1');
    served = next.file;
    mkdirSync(place.previous);
    writeFileSync(path.join(place.previous, 'stale'), 'from the update before');
    await prepareBundle({ place, bundle: next.sha256, url, node: process.execPath });
    swapBundle(place);
    expect(ownVersion(place.dir)).toBe('1.0.1');
    expect(ownBundle(place.dir)).toBe(next.sha256);
    expect(ownVersion(place.previous)).toBe('1.0.0');
    expect(existsSync(path.join(place.previous, 'stale'))).toBe(false);
    expect(existsSync(place.next)).toBe(false);
  });

  it('puts the running one back when the new one cannot move in', () => {
    expect(() => swapBundle(place)).toThrow();
    expect(ownVersion(place.dir)).toBe('1.0.0');
    expect(existsSync(place.previous)).toBe(false);
  });
});
