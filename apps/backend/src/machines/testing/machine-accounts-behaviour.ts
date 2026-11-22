import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Database } from '../../platform/lib/db-interface.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { MACHINE_CODE_TTL_SECONDS } from '../lib/machines.js';
import { checkWorkToken } from '../lib/work-tokens.js';
import { anyOf, containing } from '../../platform/lib/test-matchers.js';
import { MachineAccounts, type MachineAccountsDeps, type MachineFollowers } from '../services/MachineAccounts.js';
import { machineClientsAt, machineSignInKey, machineTokenAt } from '../../instances/testing/registration-code.js';

export function machineAccountsBehaviour(make: () => Promise<Database>): void {
  const DAY = 24 * 60 * 60 * 1000;
  const ROOT_URL = 'https://app.koala.example';
  const signing = identityKeysFrom(generateIdentityKey());

  let db: Database;
  let followers: ReturnType<typeof mock<MachineFollowers>>;
  let told: Array<[string, string, unknown]>;
  let browsersTold: string[];
  let mesh: ReturnType<typeof mock<Required<NonNullable<MachineAccountsDeps['mesh']>>>>;
  let clock: Date;
  let registrations: Array<{ id: string; ownerId: string }>;

  const accounts = (over: Partial<MachineAccountsDeps> = {}, meshLoginServer: string | undefined = 'https://mesh.koala.example') => new MachineAccounts({
    store: db.machines,
    signing,
    settings: { url: ROOT_URL, meshLoginServer, registry: '100.64.0.1:5001' },
    koala: { of: async (ownerId) => (ownerId === 'bo' ? { url: 'https://bo.people.example', audience: 'inst-bo' } : undefined) },
    followers,
    toMachines: { removed: (deviceId) => { told.push([deviceId, 'machine:removed', undefined]); return true; }, koala: (deviceId, koala) => { told.push([deviceId, 'machine:koala', koala]); return true; } },
    toOwner: { machinesChanged: (ownerId) => { browsersTold.push(ownerId); } },
    mesh,
    clients: { ...machineClientsAt(db), machineRegistrationCode: async (machine) => { registrations.push(machine); return `registration-${registrations.length}`; } },
    now: () => clock,
    ...over,
  });

  const keyProof = async (deviceId: string): Promise<string> => {
    await db.machines.updateLocalAgentDevice(deviceId, { set: { signIn: machineSignInKey() } });
    return machineTokenAt(db, deviceId);
  };

  const stored = async (id: string) => (await db.machines.getLocalAgentDevices()).find((candidate) => candidate.id === id);

  const joined = async (machines: MachineAccounts, ownerId = 'bo', body: Parameters<MachineAccounts['join']>[1] = { hostname: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64' }) => {
    const { code } = await machines.createJoinCode(ownerId);
    const outcome = await machines.join(code, body);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  };

  beforeEach(async () => {
    db = await make();
    clock = new Date(Math.floor(Date.now() / 1000) * 1000);
    registrations = [];
    followers = mock<MachineFollowers>();
    followers.joined.mockResolvedValue(undefined);
    followers.removed.mockResolvedValue(undefined);
    followers.changed.mockResolvedValue(undefined);
    told = [];
    browsersTold = [];
    mesh = mock<Required<NonNullable<MachineAccountsDeps['mesh']>>>();
    mesh.createPreAuthKey.mockResolvedValue({ key: 'preauth-key' });
  });

  describe('adding a machine to the account, at root', () => {
    it('gives a one-line command from root whose code expires with the hour', async () => {
      const made = await accounts().createJoinCode('bo');
      expect(made.command).toBe(`curl -fsSL ${ROOT_URL}/machine.sh | sh -s -- ${made.code}`);
      expect(Date.parse(made.expiresAt) - clock.getTime()).toBe(MACHINE_CODE_TTL_SECONDS * 1000);
    });

    it('counts the hour from the time it is now when it is given no clock', async () => {
      const before = Date.now();
      const made = await accounts({ now: undefined }).createJoinCode('bo');
      expect(Date.parse(made.expiresAt)).toBeGreaterThanOrEqual(before + MACHINE_CODE_TTL_SECONDS * 1000);
      expect(Date.parse(made.expiresAt)).toBeLessThanOrEqual(Date.now() + MACHINE_CODE_TTL_SECONDS * 1000);
    });

    it('joins the machine once, handing it a one-use code to register its own key rather than a token of root\'s, and tells its Koala', async () => {
      const machines = accounts();
      const { code } = await machines.createJoinCode('bo');
      const outcome = await machines.join(code, { hostname: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64' });
      if (!outcome.ok) throw new Error(outcome.error);
      const { deviceId, env } = outcome.value;
      expect(env).toMatchObject({ KOALA_ROOT_URL: ROOT_URL, KOALA_DEVICE_ID: deviceId, KOALA_ROOT_DIR: '/home/me/koala', MESH_LOGIN_SERVER: 'https://mesh.koala.example', MESH_AUTH_KEY: 'preauth-key', KOALA_REGISTRY: '100.64.0.1:5001', KOALA_REGISTRATION_TOKEN: 'registration-1' });
      expect(registrations).toEqual([{ id: deviceId, ownerId: 'bo' }]);
      const saved = (await stored(deviceId))!;
      expect(saved).toMatchObject({ ownerId: 'bo', name: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64', createdAt: clock.toISOString() });
      expect(Object.keys(env).sort()).toEqual(['KOALA_DEVICE_ID', 'KOALA_REGISTRATION_TOKEN', 'KOALA_REGISTRY', 'KOALA_ROOT_DIR', 'KOALA_ROOT_URL', 'MESH_AUTH_KEY', 'MESH_LOGIN_SERVER']);
      expect(Object.keys(saved).sort()).toEqual(['createdAt', 'id', 'joinedAt', 'name', 'os', 'ownerId', 'rootDir']);
      expect(saved.joinedAt).toBe(clock.toISOString());
      expect(followers.joined).toHaveBeenCalledWith({ id: deviceId, ownerId: 'bo', name: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64', createdAt: clock.toISOString() });
      expect(await machines.join(code, { hostname: 'other', rootDir: '/x' })).toEqual({ ok: false, status: 401, error: 'that command has expired or was already used: make a new one on My Machines' });
    });

    it('refuses a code it never gave, one that has run out, and a request without a code or a full path', async () => {
      const machines = accounts();
      expect(await machines.join(undefined, { rootDir: '/x' })).toEqual({ ok: false, status: 400, error: 'send the code from My Machines as "code"' });
      expect(await machines.join('made-up', { rootDir: '/x' })).toMatchObject({ ok: false, status: 401 });
      const { code } = await machines.createJoinCode('bo');
      expect(await machines.join(code, { rootDir: 'koala' })).toEqual({ ok: false, status: 400, error: 'send the folder Koala may work in as "rootDir", a full path' });
      clock = new Date(clock.getTime() + (MACHINE_CODE_TTL_SECONDS + 1) * 1000);
      expect(await machines.join(code, { rootDir: '/x' })).toMatchObject({ ok: false, status: 401 });
    });

    it('names a machine "machine" when it sends no name, and shortens what it sends', async () => {
      const machines = accounts();
      const nameless = await joined(machines, 'bo', { rootDir: '/home/me/koala' });
      expect((await stored(nameless.deviceId))?.name).toBe('machine');
      const long = await joined(machines, 'bo', { hostname: ` ${'h'.repeat(200)} `, rootDir: '/', os: '  ' });
      expect((await stored(long.deviceId))?.name).toHaveLength(80);
      expect((await stored(long.deviceId))?.os).toBeUndefined();
    });

    it('still joins when its Koala cannot be told, saying so', async () => {
      followers.joined.mockRejectedValue(new Error('instance is down'));
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const outcome = await joined(accounts());
      expect(await stored(outcome.deviceId)).toBeDefined();
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('instance is down'));
      warned.mockRestore();
    });

    it('replaces the machine it ran on before when the command runs there again, keeping it and telling no Koala of a new one', async () => {
      const machines = accounts();
      const first = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/home/me/koala' });
      const before = (await stored(first.deviceId))!;
      followers.joined.mockClear();
      const { code } = await machines.createJoinCode('bo');
      const again = await machines.join(code, { hostname: 'desk', rootDir: '/home/me/work', replaces: await keyProof(first.deviceId) });
      expect(again.ok && again.value.deviceId).toBe(first.deviceId);
      const replaced = (await stored(first.deviceId))!;
      expect(replaced).toMatchObject({ rootDir: '/home/me/work', createdAt: before.createdAt });
      expect(replaced.signIn).toBeUndefined();
      expect(await db.machines.getLocalAgentDevices()).toHaveLength(1);
      expect(followers.joined).not.toHaveBeenCalled();
    });

    it('adds a second machine rather than replace one that is not the person\'s own', async () => {
      const machines = accounts();
      const first = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/x' });
      const stranger = await joined(machines, 'cy', { hostname: 'desk', rootDir: '/x', replaces: await keyProof(first.deviceId) });
      expect(stranger.deviceId).not.toBe(first.deviceId);
      expect(await db.machines.getLocalAgentDevices()).toHaveLength(2);
    });

    it('replaces the person\'s machine that never registered a key when a later join names it, keeping its one entry and telling no Koala of a new one', async () => {
      const machines = accounts();
      const first = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/home/me/koala' });
      followers.joined.mockClear();
      const again = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/home/me/work', neverRegistered: first.deviceId });
      expect(again.deviceId).toBe(first.deviceId);
      expect(await db.machines.getLocalAgentDevices()).toHaveLength(1);
      expect((await stored(first.deviceId))?.rootDir).toBe('/home/me/work');
      expect(followers.joined).not.toHaveBeenCalled();
    });

    it('adds a machine rather than replace one named by its id that holds a key, or that is another person\'s', async () => {
      const machines = accounts();
      const keyed = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/x' });
      await db.machines.updateLocalAgentDevice(keyed.deviceId, { set: { signIn: machineSignInKey() } });
      const unkeyed = await joined(machines, 'bo', { hostname: 'laptop', rootDir: '/x' });
      const byId = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/x', neverRegistered: keyed.deviceId });
      const stranger = await joined(machines, 'cy', { hostname: 'laptop', rootDir: '/x', neverRegistered: unkeyed.deviceId });
      expect([byId.deviceId, stranger.deviceId]).not.toContain(keyed.deviceId);
      expect(stranger.deviceId).not.toBe(unkeyed.deviceId);
      expect(await db.machines.getLocalAgentDevices()).toHaveLength(4);
    });

    it('shows the person why a machine could not replace its key and when that key stops working, until it replaces it', async () => {
      const machines = accounts();
      const { deviceId } = await joined(machines);
      const since = '2026-09-01T00:00:00.000Z';
      await db.machines.updateLocalAgentDevice(deviceId, { set: { signIn: { ...machineSignInKey(), since } } });
      await machines.keyReplaced(deviceId, { replaced: false, problem: 'the disk was full' });
      expect((await machines.listOnline('bo'))[0]?.keyReplacement).toEqual({ reason: 'the disk was full', failedAt: clock.toISOString(), stopsAt: '2026-11-30T00:00:00.000Z' });
      expect(browsersTold).toContain('bo');
      await machines.keyReplaced(deviceId, { replaced: true });
      expect((await machines.listOnline('bo'))[0]?.keyReplacement).toBeUndefined();
    });

    it('replaces the machine whose key the command proves, even once that key has lived its 90 days', async () => {
      const machines = accounts();
      const first = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/home/me/koala' });
      await db.machines.updateLocalAgentDevice(first.deviceId, { set: { signIn: { ...machineSignInKey(), since: new Date(Date.now() - 91 * DAY).toISOString() } } });
      const { code } = await machines.createJoinCode('bo');
      const again = await machines.join(code, { hostname: 'desk', rootDir: '/home/me/work', replaces: await machineTokenAt(db, first.deviceId) });
      expect(again.ok && again.value.deviceId).toBe(first.deviceId);
      expect(await db.machines.getLocalAgentDevices()).toHaveLength(1);
    });

    it('hands a machine a key to the private network when root has one, and refuses when it cannot make one', async () => {
      const { env } = await joined(accounts({}, 'https://mesh.koala.example'));
      expect(env).toMatchObject({ MESH_LOGIN_SERVER: 'https://mesh.koala.example', MESH_AUTH_KEY: 'preauth-key' });
      expect(mesh.createPreAuthKey).toHaveBeenCalledWith('bo', { reusable: false, expirySeconds: MACHINE_CODE_TTL_SECONDS });
      const blind = accounts({ mesh: undefined }, 'https://mesh.koala.example');
      const { code } = await blind.createJoinCode('bo');
      expect(await blind.join(code, { rootDir: '/x' })).toEqual({ ok: false, status: 503, error: 'this Koala has a mesh address but cannot reach Headscale to let the machine join it' });
    });

    it('adds no machine where root runs no private network, saying why, since a machine takes work only over it', async () => {
      const meshless = accounts({}, '');
      const said = 'Koala\'s root runs no private network (MESH_LOGIN_SERVER is not set), and a machine takes work only over it, so none can be added';
      await expect(meshless.createJoinCode('bo')).rejects.toMatchObject({ status: 409, message: said });
      const { code } = await accounts().createJoinCode('bo');
      expect(await meshless.join(code, { rootDir: '/x' })).toEqual({ ok: false, status: 409, error: said });
      expect(await db.machines.getLocalAgentDevices()).toEqual([]);
    });

    it('lists a person\'s machines as their Koala needs them, without any token', async () => {
      const machines = accounts();
      const mine = await joined(machines, 'bo');
      await joined(machines, 'cy');
      const listed = await machines.list('bo');
      expect(listed).toEqual([{ id: mine.deviceId, ownerId: 'bo', name: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64', createdAt: clock.toISOString() }]);
    });
  });

  describe('a join\'s progress, as the machine reports it with its code', () => {
    const started = { stage: 'k3s', title: 'Installing k3s', state: 'started' };
    const failed = { stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'the k3s downloaded is not the one Koala pins' };
    const minutes = (count: number) => { clock = new Date(clock.getTime() + count * 60_000); };

    it('records each stage on the join, from when the code is made until after the machine joined, and tells the owner\'s browsers', async () => {
      const machines = accounts();
      const { code, expiresAt } = await machines.createJoinCode('bo');
      expect(await machines.joins('bo')).toEqual([]);
      expect(await machines.reportJoinProgress(code, { stage: 'node', title: 'Node.js of Koala\'s own', state: 'already-done' })).toEqual({ ok: true, value: { recorded: true } });
      expect(browsersTold).toEqual(['bo']);
      const [first] = await machines.joins('bo');
      expect(first).toEqual({ id: anyOf(String), stage: 'node', title: 'Node.js of Koala\'s own', state: 'already-done', at: clock.toISOString(), expiresAt, joined: false });
      const outcome = await machines.join(code, { hostname: 'desk', rootDir: '/home/me/koala' });
      if (!outcome.ok) throw new Error(outcome.error);
      minutes(5);
      expect(await machines.reportJoinProgress(code, started)).toEqual({ ok: true, value: { recorded: true } });
      expect(await machines.joins('bo')).toEqual([{ id: first!.id, ...started, at: clock.toISOString(), expiresAt, joined: true }]);
      expect(await machines.joins('cy')).toEqual([]);
      expect(JSON.stringify(await machines.joins('bo'))).not.toContain(code);
    });

    it('refuses a report without the code, with one it never gave or that ran out, and one that does not follow the contract, recording nothing', async () => {
      const machines = accounts();
      const { code } = await machines.createJoinCode('bo');
      expect(await machines.reportJoinProgress(undefined, started)).toMatchObject({ ok: false, status: 401 });
      expect(await machines.reportJoinProgress('made-up', started)).toMatchObject({ ok: false, status: 401 });
      expect(await machines.reportJoinProgress(code, { ...started, state: 'skipped' })).toMatchObject({ ok: false, status: 400, error: containing('"state"') });
      expect(await machines.reportJoinProgress(code, { stage: 'k3s', title: 'Installing k3s', state: 'failed' })).toMatchObject({ ok: false, status: 400 });
      minutes(61);
      expect(await machines.reportJoinProgress(code, started)).toEqual({ ok: false, status: 401, error: 'that command has expired, or its join has finished or was dismissed: make a new one on My Machines' });
      expect(await machines.joins('bo')).toEqual([]);
      expect(browsersTold).toEqual([]);
    });

    it('keeps a failed join with its stage and why after its code runs out, until the same command runs again and replaces it', async () => {
      const machines = accounts();
      const { code } = await machines.createJoinCode('bo');
      await machines.reportJoinProgress(code, failed);
      minutes(1);
      expect(await machines.reportJoinProgress(code, started)).toMatchObject({ ok: true });
      expect((await machines.joins('bo')).map((join) => [join.state, join.why])).toEqual([['started', undefined]]);
      await machines.reportJoinProgress(code, failed);
      minutes(120);
      expect(await machines.joins('bo')).toEqual([expect.objectContaining(failed)]);
      expect((await db.machines.getMachineJoin(createHash('sha256').update(code).digest('hex')))?.keptUntil).toBeUndefined();
    });

    it('lets a code nobody ran go with its hour, and keeps one that reported or joined until it ends', async () => {
      const machines = accounts();
      const quiet = await machines.createJoinCode('bo');
      const reporting = await machines.createJoinCode('bo');
      const used = await machines.createJoinCode('bo');
      const hashOf = (code: string) => createHash('sha256').update(code).digest('hex');
      expect((await db.machines.getMachineJoin(hashOf(quiet.code)))?.keptUntil).toBe(quiet.expiresAt);
      await machines.reportJoinProgress(reporting.code, started);
      expect((await db.machines.getMachineJoin(hashOf(reporting.code)))?.keptUntil).toBeUndefined();
      expect(await machines.join(used.code, { hostname: 'desk', rootDir: '/home/me/koala' })).toMatchObject({ ok: true });
      expect((await db.machines.getMachineJoin(hashOf(used.code)))?.keptUntil).toBeUndefined();
    });

    it('keeps hearing a join after its code\'s hour once the machine joined with it, since a join has no deadline', async () => {
      const machines = accounts();
      const { code } = await machines.createJoinCode('bo');
      expect(await machines.join(code, { hostname: 'desk', rootDir: '/home/me/koala' })).toMatchObject({ ok: true });
      minutes(180);
      expect(await machines.reportJoinProgress(code, { stage: 'k3s', title: 'Installing k3s', state: 'done' })).toEqual({ ok: true, value: { recorded: true } });
      expect(await machines.joins('bo')).toEqual([expect.objectContaining({ stage: 'k3s', state: 'done', at: clock.toISOString(), joined: true })]);
    });

    it('ends a join once the machine it made has connected and its last stage is done, hearing the stage still running when it connected', async () => {
      const machines = accounts();
      const { code } = await machines.createJoinCode('bo');
      const hash = createHash('sha256').update(code).digest('hex');
      const outcome = await machines.join(code, { hostname: 'desk', rootDir: '/home/me/koala' });
      if (!outcome.ok) throw new Error(outcome.error);
      await machines.reportJoinProgress(code, { stage: 'service', title: 'Starting it', state: 'started' });
      browsersTold = [];
      await machines.joinFinished(outcome.value.deviceId);
      expect(await machines.joins('bo')).toEqual([]);
      expect(browsersTold).toEqual(['bo']);
      expect(await db.machines.getMachineJoin(hash)).toBeDefined();
      expect(await machines.reportJoinProgress(code, { stage: 'service', title: 'Starting it', state: 'done' })).toMatchObject({ ok: true });
      expect(await db.machines.getMachineJoin(hash)).toBeUndefined();
      expect(await machines.reportJoinProgress(code, started)).toMatchObject({ ok: false, status: 401 });
      browsersTold = [];
      await machines.joinFinished(outcome.value.deviceId);
      await machines.joinFinished('gone');
      expect(browsersTold).toEqual([]);
    });

    it('ends a join at once when its machine connects after its last stage was done', async () => {
      const machines = accounts();
      const { code } = await machines.createJoinCode('bo');
      const outcome = await machines.join(code, { hostname: 'desk', rootDir: '/home/me/koala' });
      if (!outcome.ok) throw new Error(outcome.error);
      await machines.reportJoinProgress(code, { stage: 'helm', title: 'Installing helm', state: 'done' });
      await machines.joinFinished(outcome.value.deviceId);
      expect(await db.machines.getMachineJoin(createHash('sha256').update(code).digest('hex'))).toBeUndefined();
      expect(await machines.joins('bo')).toEqual([]);
    });

    it('shows a stage that fails after the machine connected, until dismissed', async () => {
      const machines = accounts();
      const { code } = await machines.createJoinCode('bo');
      const outcome = await machines.join(code, { hostname: 'desk', rootDir: '/home/me/koala' });
      if (!outcome.ok) throw new Error(outcome.error);
      await machines.reportJoinProgress(code, { stage: 'service', title: 'Starting it', state: 'started' });
      await machines.joinFinished(outcome.value.deviceId);
      await machines.reportJoinProgress(code, { stage: 'service', title: 'Starting it', state: 'failed', why: 'systemctl --user enable failed' });
      const [shown] = await machines.joins('bo');
      expect(shown).toMatchObject({ stage: 'service', state: 'failed', why: 'systemctl --user enable failed' });
      expect(await machines.dismissJoin('bo', shown!.id)).toMatchObject({ ok: true });
    });

    it('is finished when the machine it joined in its own place connects, and not before', async () => {
      const machines = accounts();
      const before = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/home/me/koala' });
      const { code } = await machines.createJoinCode('bo');
      const again = await machines.join(code, { hostname: 'desk', rootDir: '/home/me/koala', replaces: await keyProof(before.deviceId) });
      if (!again.ok) throw new Error(again.error);
      expect(again.value.deviceId).toBe(before.deviceId);
      await machines.reportJoinProgress(code, started);
      expect(await machines.joins('bo')).toEqual([expect.objectContaining(started)]);
      await machines.joinFinished(again.value.deviceId);
      expect(await machines.joins('bo')).toEqual([]);
    });

    it('replaces a machine\'s failed join when a new command runs on that machine, and removes it with the machine', async () => {
      const machines = accounts();
      const first = await machines.createJoinCode('bo');
      const joined1 = await machines.join(first.code, { hostname: 'desk', rootDir: '/home/me/koala' });
      if (!joined1.ok) throw new Error(joined1.error);
      await machines.reportJoinProgress(first.code, failed);
      const second = await machines.createJoinCode('bo');
      await machines.reportJoinProgress(second.code, started);
      expect(await machines.joins('bo')).toHaveLength(2);
      browsersTold = [];
      const joined2 = await machines.join(second.code, { hostname: 'desk', rootDir: '/home/me/koala', replaces: await keyProof(joined1.value.deviceId) });
      if (!joined2.ok) throw new Error(joined2.error);
      expect((await machines.joins('bo')).map((join) => join.state)).toEqual(['started']);
      expect(browsersTold).toEqual(['bo']);
      await machines.reportJoinProgress(second.code, failed);
      browsersTold = [];
      expect(await machines.remove('bo', joined2.value.deviceId)).toBe(true);
      expect(await machines.joins('bo')).toEqual([]);
      expect(browsersTold).toEqual(['bo']);
    });

    it('dismisses only the person\'s own join, once it failed, its unused command expired, or the machine joined with it', async () => {
      const machines = accounts();
      const { code } = await machines.createJoinCode('bo');
      await machines.reportJoinProgress(code, started);
      const [join] = await machines.joins('bo');
      expect(await machines.dismissJoin('bo', join!.id)).toEqual({ ok: false, status: 409, error: 'that command can still join a machine; it can be dismissed once it fails, its command expires or a machine joins with it' });
      await machines.reportJoinProgress(code, failed);
      expect(await machines.dismissJoin('cy', join!.id)).toEqual({ ok: false, status: 404, error: 'no such join on your account' });
      expect(await machines.dismissJoin('bo', 'nothing')).toEqual({ ok: false, status: 404, error: 'no such join on your account' });
      browsersTold = [];
      expect(await machines.dismissJoin('bo', join!.id)).toEqual({ ok: true, value: { dismissed: true } });
      expect(await machines.joins('bo')).toEqual([]);
      expect(browsersTold).toEqual(['bo']);
      expect(await machines.reportJoinProgress(code, started)).toMatchObject({ ok: false, status: 401 });
      const quiet = await machines.createJoinCode('bo');
      await machines.reportJoinProgress(quiet.code, started);
      minutes(61);
      const [expired] = await machines.joins('bo');
      expect(await machines.dismissJoin('bo', expired!.id)).toMatchObject({ ok: true });
      const used = await machines.createJoinCode('bo');
      expect(await machines.join(used.code, { hostname: 'desk', rootDir: '/home/me/koala' })).toMatchObject({ ok: true });
      await machines.reportJoinProgress(used.code, started);
      const [joining] = await machines.joins('bo');
      expect(await machines.dismissJoin('bo', joining!.id)).toMatchObject({ ok: true });
      expect(await machines.reportJoinProgress(used.code, started)).toMatchObject({ ok: false, status: 401 });
    });

    it('lists the person\'s machines with their joins', async () => {
      const machines = accounts();
      const { deviceId } = await joined(machines, 'bo');
      const { code } = await machines.createJoinCode('bo');
      await machines.reportJoinProgress(code, started);
      const mine = await machines.mine('bo');
      expect(mine.machines.map((machine) => machine.id)).toEqual([deviceId]);
      expect(mine.joins).toEqual([expect.objectContaining(started)]);
    });
  });

  describe('taking an instance\'s machines from before root held them', () => {
    it('keeps each with its id for the instance\'s owner, once, and nothing of the token the instance once gave it', async () => {
      const machines = accounts();
      const createdAt = new Date(clock.getTime() - 30 * DAY).toISOString();
      const before = { id: 'old-desk', ownerId: 'someone-else', name: 'desk', rootDir: '/home/bo/koala', createdAt, tokenHash: 'h'.repeat(64), issuedAt: createdAt, expiresAt: clock.toISOString(), agents: [{ id: 'x' }] };
      expect(await machines.adoptFrom('bo', [before, { id: 'no-folder', name: 'x', createdAt: 'then' }, 'nonsense'])).toEqual({ adopted: 1 });
      expect(await stored('old-desk')).toEqual({ id: 'old-desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt });
      expect(await machines.adoptFrom('bo', [{ ...before, name: 'changed' }])).toEqual({ adopted: 0 });
      expect((await stored('old-desk'))?.name).toBe('desk');
    });
  });

  describe('where a machine\'s Koala is', () => {
    it('names its Koala with a work token root signed for that machine, owner and Koala', async () => {
      const machines = accounts();
      const { deviceId } = await joined(machines, 'bo');
      const koala = (await machines.koalaFor(deviceId))!;
      expect(koala.url).toBe('https://bo.people.example');
      const check = checkWorkToken(koala.workToken, trustedKeys([publicKeyPem(signing.publicKey)]), 'inst-bo', Math.floor(clock.getTime() / 1000));
      expect(check).toMatchObject({ ok: true, claims: { sub: deviceId, owner: 'bo', aud: 'inst-bo' } });
    });

    it('names none for a person with no Koala yet, or a machine that is gone, and tells each of a person\'s machines', async () => {
      const machines = accounts();
      const theirs = await joined(machines, 'cy');
      expect(await machines.koalaFor(theirs.deviceId)).toBeUndefined();
      expect(await machines.koalaFor('gone')).toBeUndefined();
      const mine = await joined(machines, 'bo');
      await machines.tellKoala('bo');
      expect(told).toEqual([[mine.deviceId, 'machine:koala', expect.objectContaining({ url: 'https://bo.people.example' })]]);
    });
  });

  describe('removing a machine', () => {
    it('tells the machine, deletes it, takes it off the mesh and tells its Koala', async () => {
      const machines = accounts();
      const { deviceId } = await joined(machines);
      await db.machines.updateLocalAgentDevice(deviceId, { set: { meshIp: '100.64.0.9' } });
      mesh.removeNode.mockResolvedValue(undefined);
      expect(await machines.remove('bo', deviceId)).toBe(true);
      expect(await stored(deviceId)).toBeUndefined();
      expect(told).toEqual([[deviceId, 'machine:removed', undefined]]);
      expect(mesh.removeNode).toHaveBeenCalledWith('bo', '100.64.0.9');
      expect(followers.removed).toHaveBeenCalledWith(expect.objectContaining({ id: deviceId, ownerId: 'bo' }));
    });

    it('removes no one else\'s machine', async () => {
      const machines = accounts();
      const theirs = await joined(machines, 'cy');
      expect(await machines.remove('bo', theirs.deviceId)).toBe(false);
      expect(await machines.remove('bo', 'nothing')).toBe(false);
      expect(await stored(theirs.deviceId)).toBeDefined();
      expect(followers.removed).not.toHaveBeenCalled();
    });

    it('is removed even when the mesh or its Koala cannot be cleaned up, saying so', async () => {
      const machines = accounts();
      const { deviceId } = await joined(machines);
      await db.machines.updateLocalAgentDevice(deviceId, { set: { meshIp: '100.64.0.9' } });
      mesh.removeNode.mockRejectedValue(new Error('headscale is down'));
      followers.removed.mockRejectedValue(new Error('instance is down'));
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await machines.remove('bo', deviceId)).toBe(true);
      expect(await stored(deviceId)).toBeUndefined();
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('headscale is down'));
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('instance is down'));
      warned.mockRestore();
    });
  });

  describe('what a machine tells root', () => {
    it('tells the owner\'s pages each time what My Machines shows of a machine changes: it joins, connects, goes off, is given its mesh address, or is removed', async () => {
      const machines = accounts();
      const { deviceId } = await joined(machines);
      expect(browsersTold).toEqual(['bo']);
      await machines.seen(deviceId);
      expect(browsersTold).toEqual(['bo', 'bo']);
      await machines.recordMeshIp(deviceId, '100.64.0.9');
      expect(browsersTold).toEqual(['bo', 'bo', 'bo']);
      await machines.recordMeshIp(deviceId, '100.64.0.9');
      await machines.wentOff(deviceId);
      expect(browsersTold).toEqual(['bo', 'bo', 'bo', 'bo']);
      mesh.removeNode.mockResolvedValue(undefined);
      expect(await machines.remove('bo', deviceId)).toBe(true);
      expect(browsersTold).toEqual(['bo', 'bo', 'bo', 'bo', 'bo']);
    });

    it('notes when it was last seen, and its mesh address, only a real one, once, telling its Koala', async () => {
      const machines = accounts();
      const { deviceId } = await joined(machines);
      await machines.seen(deviceId);
      expect((await stored(deviceId))?.lastSeenAt).toBe(clock.toISOString());
      await machines.recordMeshIp(deviceId, '100.64.0.9');
      await machines.recordMeshIp(deviceId, '10.0.0.1');
      await machines.recordMeshIp(deviceId, undefined);
      expect((await stored(deviceId))?.meshIp).toBe('100.64.0.9');
      expect(followers.changed).toHaveBeenCalledTimes(1);
      followers.changed.mockRejectedValue(new Error('instance is down'));
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await machines.recordMeshIp(deviceId, '100.64.0.10');
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('instance is down'));
      warned.mockRestore();
      const updates = vi.spyOn(db.machines, 'updateLocalAgentDevice');
      await machines.recordMeshIp(deviceId, '100.64.0.10');
      await machines.recordMeshIp('gone', '100.64.0.10');
      expect(updates).not.toHaveBeenCalled();
    });
  });

  describe('putting Koala on one of the person\'s machines', () => {
    const placing = () => {
      const started: Array<[string, string, unknown]> = [];
      const cancelled: string[] = [];
      const machines = accounts({
        installs: {
          start: async (ownerId, device, name, refused) => {
            started.push([ownerId, device.id, name]);
            if (device.meshIp) return { ok: true, value: { installId: `install-${started.length}` } };
            const refusal = { ok: false as const, status: 409 as const, error: `${device.name} is not on your private network yet; Koala is put on it once it is` };
            await refused?.(refusal);
            return refusal;
          },
          machineRemoved: async (deviceId) => { cancelled.push(deviceId); },
        },
      });
      return { machines, started, cancelled };
    };

    it('asks for Koala through the join command when the person has none, and starts putting it there once the machine is on the mesh', async () => {
      const { machines, started } = placing();
      const { code } = await machines.createJoinCode('bo', 'bobby');
      const joined = await machines.join(code, { hostname: 'desk', rootDir: '/home/bo/koala' });
      if (!joined.ok) throw new Error(joined.error);
      const id = joined.value.deviceId;
      expect((await stored(id))?.koalaWanted).toEqual({ name: 'bobby' });
      expect(await machines.deliverKoala(id)).toMatchObject({ ok: false, status: 409 });
      expect((await stored(id))?.koalaWanted).toEqual({ name: 'bobby' });
      await machines.recordMeshIp(id, '100.64.0.7');
      expect(await machines.deliverKoala(id)).toEqual({ ok: true, value: { placing: true } });
      expect(started.at(-1)).toEqual(['bo', id, 'bobby']);
      expect((await stored(id))?.koalaWanted).toBeUndefined();
      expect(await machines.deliverKoala(id)).toEqual({ ok: true, value: { placing: false } });
      expect(started).toHaveLength(2);
    });

    it('keeps a refused placement on the machine with its reason, and putting Koala there again asks again', async () => {
      const refusing = accounts({ installs: { start: async (_owner, _device, _name, refused) => {
        const refusal = { ok: false as const, status: 409 as const, error: '"bobby" is taken' };
        await refused?.(refusal);
        return refusal;
      }, machineRemoved: async () => undefined } });
      const { deviceId } = await joined(refusing, 'bo', { hostname: 'desk', rootDir: '/x' });
      await refusing.recordMeshIp(deviceId, '100.64.0.7');
      browsersTold = [];
      expect(await refusing.putKoalaOn('bo', deviceId, 'bobby')).toMatchObject({ ok: false, error: '"bobby" is taken' });
      expect(browsersTold).toEqual(['bo']);
      const [listed] = await refusing.listOnline('bo');
      expect(listed).toMatchObject({ koalaWanted: false, koalaRefused: { reason: '"bobby" is taken', at: clock.toISOString() } });
      const { machines: placingNow } = placing();
      expect(await placingNow.putKoalaOn('bo', deviceId, 'bobbie')).toEqual({ ok: true, value: { placing: true } });
      expect((await placingNow.listOnline('bo'))[0]).not.toHaveProperty('koalaRefused');
    });

    it('starts the install for a machine that is offline, to be asked of it once it connects, never puts Koala on another person\'s machine, and stops the install when the machine is removed', async () => {
      const { machines, started, cancelled } = placing();
      const { deviceId } = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/x' });
      await machines.recordMeshIp(deviceId, '100.64.0.7');
      expect(await machines.putKoalaOn('bo', deviceId, 'bobby')).toEqual({ ok: true, value: { placing: true } });
      expect(started).toEqual([['bo', deviceId, 'bobby']]);
      expect(await machines.putKoalaOn('cy', deviceId, 'cyril')).toMatchObject({ ok: false, status: 404 });
      expect((await machines.listOnline('bo')).map((machine) => [machine.id, machine.online, machine.koalaWanted])).toEqual([[deviceId, false, false]]);
      mesh.removeNode.mockResolvedValue(undefined);
      expect(await machines.remove('bo', deviceId)).toBe(true);
      expect(cancelled).toEqual([deviceId]);
    });
  });
}
