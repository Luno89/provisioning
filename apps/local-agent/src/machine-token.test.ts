import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeviceToken, workTokenExpiry } from './machine-token.js';

describe('saveDeviceToken', () => {
  let folder: string;
  afterEach(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

  it('replaces only the token in machine.json, readable by its owner alone, with no draft left behind', async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'koala-token-'));
    const file = path.join(folder, 'machine.json');
    await writeFile(file, JSON.stringify({ backendUrl: 'http://koala', token: 'old', deviceId: 'd1' }));
    await saveDeviceToken(file, 'new-token');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ backendUrl: 'http://koala', token: 'new-token', deviceId: 'd1' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(folder)).toEqual(['machine.json']);
  });

  it('makes the file when there was none', async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'koala-token-'));
    const file = path.join(folder, 'koala', 'machine.json');
    await saveDeviceToken(file, 't');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ token: 't' });
  });
});

describe('workTokenExpiry', () => {
  const token = (claims: unknown) => `head.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

  it('reads when a work token from root runs out, so the agent asks for the next before then', () => {
    expect(workTokenExpiry(token({ sub: 'm', exp: 1_800_000_000 }))).toBe(1_800_000_000);
  });

  it('reads nothing from a token without an expiry or that is not one', () => {
    expect(workTokenExpiry(token({ sub: 'm' }))).toBeUndefined();
    expect(workTokenExpiry('not-a-token')).toBeUndefined();
    expect(workTokenExpiry('a.%%%.c')).toBeUndefined();
  });
});
