import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cachedK3s, pinnedK3s, releasePath, serveK3s, type K3sMirror } from './k3s-mirror.js';

const BYTES = Buffer.from('a k3s binary');
const PIN = { version: 'v1.36.4+k3s1', sha256: createHash('sha256').update(BYTES).digest('hex') };
const dirs: string[] = [];
const mirrors: K3sMirror[] = [];
afterEach(async () => {
  for (const mirror of mirrors.splice(0)) await mirror.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'k3s-mirror-')); dirs.push(dir); return dir; };

describe('the k3s the VM suites install from this computer', () => {
  it('is the binary the pins name, for linux-amd64', () => {
    expect(pinnedK3s()).toMatchObject({ version: expect.stringMatching(/^v[0-9.]+\+k3s[0-9]+$/), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('is downloaded once from the release and kept, and a download that is not the pinned one is refused and not kept', async () => {
    const dir = fresh();
    const asked: string[] = [];
    const file = await cachedK3s(PIN, dir, async (url) => { asked.push(url); return BYTES; });
    expect(asked).toEqual(['https://github.com/k3s-io/k3s/releases/download/v1.36.4%2Bk3s1/k3s']);
    expect(await cachedK3s(PIN, dir, async () => { throw new Error('asked again'); })).toBe(file);
    await expect(cachedK3s(PIN, fresh(), async () => Buffer.from('something else'))).rejects.toThrow(/not the one dependencies.pins.json pins/);
  });

  it('is served at the path the install scripts ask for, and nothing else is', async () => {
    const file = await cachedK3s(PIN, fresh(), async () => BYTES);
    const mirror = await serveK3s(file, PIN.version, '127.0.0.1');
    mirrors.push(mirror);
    const got = await fetch(`${mirror.url}${releasePath(PIN.version)}`);
    expect(Buffer.from(await got.arrayBuffer())).toEqual(BYTES);
    expect((await fetch(`${mirror.url}/v1.36.4%2Bk3s1/k3s-arm64`)).status).toBe(404);
  });
});
