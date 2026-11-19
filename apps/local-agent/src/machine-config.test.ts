import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentsNotSetUp, configFile, folderProblem, loadMachineConfig, machineConfigFrom } from './machine-config.js';

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

describe('where a machine finds its settings', () => {
  it('reads the file the install wrote, with any setting in the environment taking its place', () => {
    const saved = { rootUrl: 'https://app.koala.example', token: 'saved', rootDir: '/home/me/koala', deviceId: 'dev-1' };
    expect(machineConfigFrom({}, saved, '/cwd')).toEqual(saved);
    expect(machineConfigFrom({ KOALA_DEVICE_TOKEN: 'from-env', KOALA_ROOT_DIR: 'work' }, saved, '/cwd')).toEqual({ ...saved, token: 'from-env', rootDir: path.resolve('work') });
  });

  it('works from the environment alone, in the folder it was started in', () => {
    expect(machineConfigFrom({ KOALA_ROOT_URL: 'http://localhost:3001', KOALA_DEVICE_TOKEN: 't' }, {}, '/here')).toEqual({ rootUrl: 'http://localhost:3001', token: 't', rootDir: '/here' });
  });

  it('says what to do when it has nowhere to connect or no token, and when it was added before machines joined through root', () => {
    expect(() => machineConfigFrom({}, {}, '/')).toThrow('this machine has no root to connect to: run the command from My Machines');
    expect(() => machineConfigFrom({ KOALA_ROOT_URL: 'http://x' }, {}, '/')).toThrow('no device token');
    expect(() => machineConfigFrom({}, { backendUrl: 'https://old.koala.example', token: 't' }, '/')).toThrow('this machine was added before machines joined through root: run the command from My Machines again');
  });

  it('keeps the file under the person\'s config folder', () => {
    expect(configFile({ XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/koala/machine.json');
    expect(configFile({ KOALA_MACHINE_CONFIG: '/x.json' })).toBe('/x.json');
  });

  it('loads the saved file, and treats a missing one as nothing saved', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'machine-config-'));
    const file = path.join(dir, 'machine.json');
    await writeFile(file, JSON.stringify({ rootUrl: 'http://k', token: 't', rootDir: dir }));
    expect(await loadMachineConfig({ KOALA_MACHINE_CONFIG: file }, '/')).toEqual({ rootUrl: 'http://k', token: 't', rootDir: dir });
    await expect(loadMachineConfig({ KOALA_MACHINE_CONFIG: path.join(dir, 'none.json') }, '/')).rejects.toThrow('no root to connect to');
  });
});

describe('the folder Koala works in on a machine', () => {
  it('is never the whole machine, the person\'s home or anything above it', () => {
    expect(folderProblem('/', '/home/sam')).toMatch(/never \/,/);
    expect(folderProblem('/home/sam', '/home/sam')).toMatch(/never \/home\/sam, which holds everything else/);
    expect(folderProblem('/home', '/home/sam')).toMatch(/pick a folder inside it, like \/home\/sam\/koala/);
    expect(folderProblem('/home/sam/koala', '/home/sam')).toBeUndefined();
    expect(folderProblem('/srv/koala-work', '/home/sam')).toBeUndefined();
    expect(folderProblem('/home/samuel', '/home/sam')).toBeUndefined();
  });
});

describe('what the machine\'s last join kept about its coding agents', () => {
  it('reads why they were not set up, fresh each time, and nothing once a join set them up', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'koala-machine-config-'));
    const file = path.join(dir, 'machine.json');
    const env = { KOALA_MACHINE_CONFIG: file };
    expect(await agentsNotSetUp(env)).toBeUndefined();
    await writeFile(file, JSON.stringify({ rootUrl: 'https://root.test', token: 't', rootDir: dir, agentsNotSetUp: 'the ACP registry could not be reached' }));
    expect(await agentsNotSetUp(env)).toBe('the ACP registry could not be reached');
    await writeFile(file, JSON.stringify({ rootUrl: 'https://root.test', token: 't', rootDir: dir }));
    expect(await agentsNotSetUp(env)).toBeUndefined();
  });
});
