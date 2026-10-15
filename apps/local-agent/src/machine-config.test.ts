import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configFile, loadMachineConfig, machineConfigFrom } from './machine-config.js';

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

describe('where a machine finds its settings', () => {
  it('reads the file the install wrote, with any setting in the environment taking its place', () => {
    const saved = { backendUrl: 'https://koala.example', token: 'saved', rootDir: '/home/me/koala', deviceId: 'dev-1', temporalAddress: '100.64.0.1:7233' };
    expect(machineConfigFrom({}, saved, '/cwd')).toEqual(saved);
    expect(machineConfigFrom({ KOALA_DEVICE_TOKEN: 'from-env', KOALA_ROOT_DIR: 'work' }, saved, '/cwd')).toEqual({ ...saved, token: 'from-env', rootDir: path.resolve('work') });
  });

  it('works from the environment alone, in the folder it was started in', () => {
    expect(machineConfigFrom({ KOALA_BACKEND_URL: 'http://localhost:3001', KOALA_DEVICE_TOKEN: 't' }, {}, '/here')).toEqual({ backendUrl: 'http://localhost:3001', token: 't', rootDir: '/here' });
  });

  it('says what to do when it has nowhere to connect or no token', () => {
    expect(() => machineConfigFrom({}, {}, '/')).toThrow('run the command from My Machines');
    expect(() => machineConfigFrom({ KOALA_BACKEND_URL: 'http://x' }, {}, '/')).toThrow('no device token');
  });

  it('keeps the file under the person\'s config folder', () => {
    expect(configFile({ XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/koala/machine.json');
    expect(configFile({ KOALA_MACHINE_CONFIG: '/x.json' })).toBe('/x.json');
  });

  it('loads the saved file, and treats a missing one as nothing saved', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'machine-config-'));
    const file = path.join(dir, 'machine.json');
    await writeFile(file, JSON.stringify({ backendUrl: 'http://k', token: 't', rootDir: dir }));
    expect(await loadMachineConfig({ KOALA_MACHINE_CONFIG: file }, '/')).toEqual({ backendUrl: 'http://k', token: 't', rootDir: dir });
    await expect(loadMachineConfig({ KOALA_MACHINE_CONFIG: path.join(dir, 'none.json') }, '/')).rejects.toThrow('no Koala to connect to');
  });
});
