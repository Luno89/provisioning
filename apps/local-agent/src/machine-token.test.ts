import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeviceToken } from './machine-token.js';

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
