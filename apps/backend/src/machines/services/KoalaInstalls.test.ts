import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { LocalAgentDeviceMetadata } from '../../platform/index.js';
import type { InstanceRecord } from '../../instances/index.js';
import { deviceTokenHash, tokenLifetime, TOKEN_EXPIRED_SAID } from '../lib/device-tokens.js';
import { KoalaInstalls, type InstallPlaces, type InstallWorkflows } from './KoalaInstalls.js';

const NOW = new Date('2026-11-18T10:00:00Z');
const TOKEN = 'desk-token-0123456789-0123456789';
const desk: LocalAgentDeviceMetadata = { id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: NOW.toISOString(), meshIp: '100.64.0.7', tokenHash: deviceTokenHash(TOKEN), ...tokenLifetime(NOW) };
const installOf = (state: 'asked' | 'installing' | 'ready' | 'failed', more: Partial<NonNullable<InstanceRecord['install']>> = {}): InstanceRecord => ({
  id: 'inst-bo', ownerId: 'bo', url: '', createdAt: 't', updatedAt: 't', machine: 'desk', machineId: 'desk', meshIp: '100.64.0.7',
  install: { id: 'install-1', machineId: 'desk', state, at: 't', ...more },
});
const placed = { installId: 'install-1', instanceId: 'inst-bo', ownerId: 'bo', machineId: 'desk', rootUrl: 'http://root.test', rootPublicKeys: 'PEM', meshLoginServer: 'https://mesh', meshAddress: '100.64.0.7', image: 'r/app', imageTag: 'v1', chartUrl: 'http://root.test/c.tgz', credential: 'c', name: 'bobby', domain: '' };

let places: ReturnType<typeof mock<InstallPlaces>>;
let workflows: ReturnType<typeof mock<InstallWorkflows>>;
let handed: string[];
let told: string[];
let installs: KoalaInstalls;

beforeEach(() => {
  places = mock<InstallPlaces>();
  workflows = mock<InstallWorkflows>();
  workflows.start.mockResolvedValue(undefined);
  workflows.progress.mockResolvedValue(undefined);
  workflows.setup.mockResolvedValue(undefined);
  workflows.reconnected.mockResolvedValue(undefined);
  workflows.cancel.mockResolvedValue(undefined);
  handed = [];
  told = [];
  installs = new KoalaInstalls({
    devices: async () => [desk],
    places: () => places,
    workflows,
    toMachines: { placeKoala: async (deviceId) => { handed.push(deviceId); return true; } },
    toOwner: { installChanged: (ownerId) => { told.push(ownerId); } },
    newId: () => 'install-2',
    now: () => NOW,
  });
});

describe('root putting Koala on a machine, its pieces stood in for', () => {
  it('records the install, stops the one it replaces, starts its workflow and tells the owner', async () => {
    places.placeOn.mockResolvedValue({ ok: true, value: { instanceId: 'inst-bo', replaces: 'install-1' } });
    expect(await installs.start('bo', desk, 'bobby')).toEqual({ ok: true, value: { installId: 'install-2' } });
    expect(places.placeOn).toHaveBeenCalledWith('bo', { id: 'desk', name: 'desk', meshIp: '100.64.0.7' }, 'bobby', 'install-2');
    expect(workflows.cancel).toHaveBeenCalledWith('install-1');
    expect(workflows.start).toHaveBeenCalledWith('install-2', 'bo');
    expect(told).toEqual(['bo']);
  });

  it('passes a refused placement on as it is, starting nothing', async () => {
    places.placeOn.mockResolvedValue({ ok: false, status: 409, error: 'desk is not on your private network yet' });
    expect(await installs.start('bo', desk, 'bobby')).toEqual({ ok: false, status: 409, error: 'desk is not on your private network yet' });
    expect(workflows.start).not.toHaveBeenCalled();
  });

  it('ends an install whose workflow could not start as failed, saying why', async () => {
    places.placeOn.mockResolvedValue({ ok: true, value: { instanceId: 'inst-bo' } });
    workflows.start.mockRejectedValue(new Error('Temporal is down'));
    expect(await installs.start('bo', desk, 'bobby')).toEqual({ ok: false, status: 503, error: 'root could not start putting Koala on desk: Temporal is down' });
    expect(places.installNotStarted).toHaveBeenCalledWith('inst-bo', 'install-2', 'root could not start putting Koala on desk: Temporal is down');
  });

  it('hands a stage to the workflow only from the machine the install is for, holding its own token, while the install runs', async () => {
    places.installOf.mockResolvedValue(installOf('installing'));
    const stage = { stage: 'koala', title: 'Koala', state: 'started' };
    expect(await installs.report('install-1', undefined, stage)).toMatchObject({ ok: false, status: 401 });
    expect(await installs.report('install-1', 'not-a-token', stage)).toMatchObject({ ok: false, status: 401 });
    expect(await installs.report('install-1', TOKEN, { ...stage, state: 'skipped' })).toMatchObject({ ok: false, status: 400 });
    expect(await installs.report('install-1', TOKEN, stage)).toEqual({ ok: true, value: { recorded: true } });
    expect(workflows.progress).toHaveBeenCalledWith('install-1', stage);
    places.installOf.mockResolvedValue(installOf('installing', { machineId: 'laptop' }));
    expect(await installs.report('install-1', TOKEN, stage)).toMatchObject({ ok: false, status: 404 });
    places.installOf.mockResolvedValue(installOf('ready'));
    expect(await installs.report('install-1', TOKEN, stage)).toEqual({ ok: false, status: 409, error: 'that install has ended ready' });
  });

  it('checks where Koala answers before the workflow hears it, and answers 503 while the workflow cannot be reached', async () => {
    places.installOf.mockResolvedValue(installOf('installing'));
    places.installedUrl.mockResolvedValueOnce({ ok: false, status: 400, error: 'root does not call http://127.0.0.1' });
    const ended = { stage: 'koala', title: 'Koala', state: 'done', url: 'http://127.0.0.1' };
    expect(await installs.report('install-1', TOKEN, ended)).toEqual({ ok: false, status: 400, error: 'root does not call http://127.0.0.1' });
    places.installedUrl.mockResolvedValue({ ok: true, value: 'http://100.64.0.7:30320' });
    workflows.progress.mockRejectedValueOnce(new Error('Temporal is down'));
    expect(await installs.report('install-1', TOKEN, { ...ended, url: 'http://100.64.0.7:30320/' })).toMatchObject({ ok: false, status: 503 });
    expect(await installs.report('install-1', TOKEN, { ...ended, url: 'http://100.64.0.7:30320/' })).toEqual({ ok: true, value: { recorded: true } });
    expect(workflows.progress).toHaveBeenLastCalledWith('install-1', { ...ended, url: 'http://100.64.0.7:30320' });
  });

  it('hands each line of Koala setting itself up to the install it ends, and answers 503 while that workflow cannot be reached', async () => {
    const line = { revision: 1, progress: { stage: 'gitea', title: 'Gitea', state: 'started' as const, line: 'waiting for statefulset/gitea' } };
    expect(await installs.setupHeard('install-1', line)).toEqual({ ok: true, value: { recorded: true } });
    expect(workflows.setup).toHaveBeenCalledWith('install-1', line);
    workflows.setup.mockRejectedValueOnce(new Error('Temporal is down'));
    expect(await installs.setupHeard('install-1', line)).toEqual({ ok: false, status: 503, error: 'root could not hand this to the install it follows: Temporal is down' });
  });

  it('asks the machine once for each ask its workflow records, and never for an install that has ended or was replaced', async () => {
    places.placedKoala.mockResolvedValue({ ok: true, value: placed });
    await installs.relay(installOf('asked'));
    await installs.relay(installOf('asked', { askedAt: 'first' }));
    await installs.relay(installOf('installing', { askedAt: 'first' }));
    await installs.relay(installOf('installing', { askedAt: 'second' }));
    await installs.relay(installOf('ready', { askedAt: 'third' }));
    places.placedKoala.mockResolvedValue({ ok: false, status: 404, error: 'no such install' });
    await installs.relay(installOf('installing', { askedAt: 'fourth' }));
    expect(handed).toEqual(['desk', 'desk']);
    expect(told).toHaveLength(6);
  });

  it('asks the workflow again when the machine comes back, and stops it when the machine is removed, only for an install under way', async () => {
    places.installsOn.mockResolvedValue([installOf('installing'), { ...installOf('failed'), install: { id: 'install-0', machineId: 'desk', state: 'failed', at: 't' } }]);
    await installs.connected('desk');
    await installs.machineRemoved('desk');
    expect(workflows.reconnected.mock.calls).toEqual([['install-1']]);
    expect(workflows.cancel.mock.calls).toEqual([['install-1']]);
  });

  it('judges the machine\'s token by the time it is now when given no clock, refusing one that lapsed', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const lapsed = { ...desk, ...tokenLifetime(new Date(Date.now() - 200 * DAY)) };
    const current = { ...desk, ...tokenLifetime(new Date()) };
    const devices: LocalAgentDeviceMetadata[] = [lapsed];
    const clocked = new KoalaInstalls({ devices: async () => devices, places: () => places, workflows, toMachines: { placeKoala: async () => true }, toOwner: { installChanged: () => undefined } });
    places.installOf.mockResolvedValue(installOf('installing'));
    const stage = { stage: 'koala', title: 'Koala', state: 'started' };
    expect(await clocked.report('install-1', TOKEN, stage)).toMatchObject({ ok: false, status: 401, error: TOKEN_EXPIRED_SAID });
    devices[0] = current;
    expect(await clocked.report('install-1', TOKEN, stage)).toEqual({ ok: true, value: { recorded: true } });
  });
});
