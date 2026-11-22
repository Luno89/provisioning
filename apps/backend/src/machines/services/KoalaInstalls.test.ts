import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { LocalAgentDeviceMetadata } from '../../platform/index.js';
import type { InstanceRecord } from '../../instances/index.js';
import { KoalaInstalls, type InstallPlaces, type InstallWorkflows } from './KoalaInstalls.js';
import { FOLLOW_GONE, MACHINE_GONE, type InstallFollowing } from '../lib/koala-install-following.js';

const NOW = new Date('2026-11-18T10:00:00Z');
const TOKEN = 'desk-key-token-0123456789-0123456789';
const desk: LocalAgentDeviceMetadata = { id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: NOW.toISOString(), meshIp: '100.64.0.7' };
const callers = { machineCaller: async (token: string) => (token === TOKEN ? { deviceId: 'desk', ownerId: 'bo', until: NOW.getTime() + 300_000, keyEnds: NOW.getTime() + 90 * 24 * 3600_000 } : undefined) };
const installOf = (state: 'asked' | 'installing' | 'ready' | 'failed', more: Partial<NonNullable<InstanceRecord['install']>> = {}): InstanceRecord => ({
  id: 'inst-bo', ownerId: 'bo', url: '', createdAt: 't', updatedAt: 't', machine: 'desk', machineId: 'desk', meshIp: '100.64.0.7',
  install: { id: 'install-1', machineId: 'desk', state, at: 't', ...more },
});
const placed = { installId: 'install-1', instanceId: 'inst-bo', ownerId: 'bo', machineId: 'desk', rootUrl: 'http://root.test', rootPublicKeys: 'PEM', meshLoginServer: 'https://mesh', meshAddress: '100.64.0.7', image: 'r/app', imageTag: 'v1', chartUrl: 'http://root.test/c.tgz', registrationCode: 'c', name: 'bobby', domain: '' };

let places: ReturnType<typeof mock<InstallPlaces>>;
let workflows: ReturnType<typeof mock<InstallWorkflows>>;
let handed: string[];
let told: string[];
let stopped: Array<[string, unknown]>;
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
  stopped = [];
  installs = new KoalaInstalls({
    devices: async () => [desk],
    callers,
    places: () => places,
    workflows,
    toMachines: { placeKoala: async (deviceId) => { handed.push(deviceId); return true; }, stopKoala: (deviceId, stop) => { stopped.push([deviceId, stop]); return true; } },
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

  it('records why the machine was refused before the install shows failed, so nobody reads a failed install with no reason on its machine', async () => {
    const order: string[] = [];
    places.placeOn.mockResolvedValue({ ok: true, value: { instanceId: 'inst-bo' } });
    places.installNotStarted.mockImplementation(async () => { order.push('install failed'); });
    workflows.start.mockRejectedValue(new Error('Temporal is down'));
    await installs.start('bo', desk, 'bobby', async (refusal) => { order.push(`refused ${refusal.status}: ${refusal.error}`); });
    expect(order).toEqual(['refused 503: root could not start putting Koala on desk: Temporal is down', 'install failed']);
    places.placeOn.mockResolvedValue({ ok: false, status: 409, error: '"bobby" is taken' });
    await installs.start('bo', desk, 'bobby', async (refusal) => { order.push(`refused ${refusal.status}: ${refusal.error}`); });
    expect(order.at(-1)).toBe('refused 409: "bobby" is taken');
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

  it('tells the machine once to stop an install that ended failed', async () => {
    await installs.relay(installOf('failed'));
    await installs.relay(installOf('failed'));
    await installs.relay({ ...installOf('failed'), install: { id: 'install-3', machineId: 'desk', state: 'failed', at: 't' } });
    await installs.relay(installOf('ready', { id: 'install-5' }));
    await installs.relay(installOf('installing', { id: 'install-6' }));
    expect(stopped).toEqual([
      ['desk', { installId: 'install-1' }],
      ['desk', { installId: 'install-3' }],
    ]);
  });

  it('tells a machine that comes back again to stop each install on it that ended failed, since it may have missed it', async () => {
    places.installsOn.mockResolvedValue([installOf('installing', { id: 'install-2' }), installOf('failed'), installOf('ready', { id: 'install-5' })]);
    await installs.connected('desk');
    await installs.connected('desk');
    expect(stopped).toEqual([['desk', { installId: 'install-1' }], ['desk', { installId: 'install-1' }]]);
  });

  it('asks the workflow again when the machine comes back, and stops it when the machine is removed, only for an install under way', async () => {
    places.installsOn.mockResolvedValue([installOf('installing'), { ...installOf('failed'), install: { id: 'install-0', machineId: 'desk', state: 'failed', at: 't' } }]);
    await installs.connected('desk');
    await installs.machineRemoved('desk');
    expect(workflows.reconnected.mock.calls).toEqual([['install-1']]);
    expect(workflows.cancel.mock.calls).toEqual([['install-1']]);
  });

  it('refuses a token root takes for a machine it no longer keeps', async () => {
    const devices: LocalAgentDeviceMetadata[] = [];
    const gone = new KoalaInstalls({ devices: async () => devices, callers, places: () => places, workflows, toMachines: { placeKoala: async () => true, stopKoala: () => true }, toOwner: { installChanged: () => undefined } });
    places.installOf.mockResolvedValue(installOf('installing'));
    const stage = { stage: 'koala', title: 'Koala', state: 'started' };
    expect(await gone.report('install-1', TOKEN, stage)).toEqual({ ok: false, status: 401, error: 'this machine is not one of Koala\'s: run the command from My Machines again' });
    devices.push(desk);
    expect(await gone.report('install-1', TOKEN, stage)).toEqual({ ok: true, value: { recorded: true } });
  });
});

describe('a joining machine following root putting Koala on it', () => {
  const LATER = new Date(NOW.getTime() + 60_000).toISOString();
  const running = (state: 'asked' | 'installing' | 'ready' | 'failed', more: Partial<NonNullable<InstanceRecord['install']>> = {}, url = ''): InstanceRecord => ({ ...installOf(state, { at: LATER, ...more }), url });

  function following(devices: LocalAgentDeviceMetadata[]) {
    const ownerTold: string[] = [];
    const followed = new KoalaInstalls({ devices: async () => devices, callers, places: () => places, workflows, toMachines: { placeKoala: async () => true, stopKoala: () => true }, toOwner: { installChanged: (ownerId) => { ownerTold.push(ownerId); } }, now: () => NOW });
    const heard: InstallFollowing[] = [];
    const broken: string[] = [];
    const listener = { told: (now: InstallFollowing) => { heard.push(now); }, broke: (err: Error) => { broken.push(err.message); } };
    return { followed, heard, broken, listener, ownerTold };
  }
  const settled = () => new Promise((done) => setImmediate(done));

  it('takes only a token root gave this machine for its key, and answers 503 where root puts Koala on no machine', async () => {
    const { followed, listener } = following([desk]);
    expect(await followed.follow(undefined, listener)).toMatchObject({ ok: false, status: 401 });
    expect(await followed.follow('another-token-0123456789-0123456789', listener)).toMatchObject({ ok: false, status: 401 });
    const removed = following([]);
    expect(await removed.followed.follow(TOKEN, removed.listener)).toMatchObject({ ok: false, status: 401 });
    const nowhere = new KoalaInstalls({ devices: async () => [desk], callers, places: () => undefined, workflows, toMachines: { placeKoala: async () => true, stopKoala: () => true }, toOwner: { installChanged: () => undefined }, now: () => NOW });
    expect(await nowhere.follow(TOKEN, listener)).toMatchObject({ ok: false, status: 503 });
  });

  it('tells each change of the install once, as root records it, and nothing after it ends', async () => {
    const { followed, heard, listener, ownerTold } = following([desk]);
    places.installsOn.mockResolvedValue([running('asked')]);
    expect(await followed.follow(TOKEN, listener)).toMatchObject({ ok: true });
    await settled();
    const chart = running('installing', { stage: 'chart', title: 'Installing Koala\'s chart', line: 'waiting for deployment/koala' });
    places.installsOn.mockResolvedValue([chart]);
    await followed.relay(chart);
    await followed.relay(chart);
    await settled();
    const ready = running('ready', { stage: 'koala', title: 'Koala' }, 'https://bobby.koala.app');
    places.installsOn.mockResolvedValue([ready]);
    await followed.relay(ready);
    await settled();
    await followed.relay(running('installing', { id: 'install-2' }));
    await settled();
    expect(heard.map((now) => (now.kind === 'followed' ? [now.followed.install.state, now.followed.install.line ?? now.followed.url] : [now.kind]))).toEqual([
      ['asked', undefined],
      ['installing', 'waiting for deployment/koala'],
      ['ready', 'https://bobby.koala.app'],
    ]);
    expect(ownerTold).toEqual(['bo', 'bo', 'bo', 'bo']);
  });

  it('waits while root has yet to start, and tells why when root would not put Koala on the machine', async () => {
    const devices: LocalAgentDeviceMetadata[] = [{ ...desk, koalaWanted: { name: 'bobby' } }];
    const { followed, heard, listener } = following(devices);
    places.installsOn.mockResolvedValue([]);
    await followed.follow(TOKEN, listener);
    await settled();
    devices[0] = { ...desk, koalaRefused: { reason: 'your Koala is on laptop; moving it is a step of its own', at: LATER } };
    followed.wake('someone-else');
    await settled();
    expect(heard).toEqual([{ kind: 'waiting' }]);
    followed.wake('bo');
    await settled();
    expect(heard).toEqual([{ kind: 'waiting' }, { kind: 'stopped', why: 'your Koala is on laptop; moving it is a step of its own' }]);
  });

  it('answers that there is nothing to follow when the join asked for no Koala, and stops when what it followed goes', async () => {
    const devices: LocalAgentDeviceMetadata[] = [desk];
    const { followed, heard, listener } = following(devices);
    places.installsOn.mockResolvedValue([]);
    await followed.follow(TOKEN, listener);
    await settled();
    expect(heard).toEqual([{ kind: 'none' }]);

    const second = following(devices);
    places.installsOn.mockResolvedValue([running('installing')]);
    await second.followed.follow(TOKEN, second.listener);
    await settled();
    places.installsOn.mockResolvedValue([]);
    second.followed.wake('bo');
    await settled();
    expect(second.heard.slice(1)).toEqual([{ kind: 'stopped', why: FOLLOW_GONE }]);

    const third = following(devices);
    places.installsOn.mockResolvedValue([running('installing')]);
    await third.followed.follow(TOKEN, third.listener);
    await settled();
    devices.splice(0);
    third.followed.wake('bo');
    await settled();
    expect(third.heard.slice(1)).toEqual([{ kind: 'stopped', why: MACHINE_GONE }]);
  });

  it('tells nothing more once the follower stops, and says so when what root holds could not be read', async () => {
    const { followed, heard, listener } = following([desk]);
    places.installsOn.mockResolvedValue([running('installing')]);
    const follow = await followed.follow(TOKEN, listener);
    if (!follow.ok) throw new Error(follow.error);
    await settled();
    follow.value.stop();
    places.installsOn.mockResolvedValue([running('failed', { why: 'no' })]);
    followed.wake('bo');
    await settled();
    expect(heard).toHaveLength(1);

    const failing = following([desk]);
    places.installsOn.mockResolvedValue([running('installing')]);
    await failing.followed.follow(TOKEN, failing.listener);
    await settled();
    places.installsOn.mockRejectedValue(new Error('Mongo is down'));
    failing.followed.wake('bo');
    await settled();
    expect(failing.broken).toEqual(['Mongo is down']);
  });
});
