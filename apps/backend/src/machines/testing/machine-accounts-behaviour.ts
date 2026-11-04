import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Database } from '../../platform/lib/db-interface.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { deviceTokenHash } from '../lib/device-tokens.js';
import { findDeviceByToken } from '../lib/local-agent-registry.js';
import { MACHINE_CODE_TTL_SECONDS } from '../lib/machines.js';
import { checkWorkToken } from '../lib/work-tokens.js';
import { MachineAccounts, type MachineAccountsDeps, type MachineFollowers } from '../services/MachineAccounts.js';

export function machineAccountsBehaviour(make: () => Promise<Database>): void {
  const DAY = 24 * 60 * 60 * 1000;
  const ROOT_URL = 'https://app.koala.example';
  const KEY = 'test-secret';
  const signing = identityKeysFrom(generateIdentityKey());

  let db: Database;
  let followers: ReturnType<typeof mock<MachineFollowers>>;
  let told: Array<[string, string, unknown]>;
  let mesh: ReturnType<typeof mock<Required<NonNullable<MachineAccountsDeps['mesh']>>>>;
  let clock: Date;

  const accounts = (over: Partial<MachineAccountsDeps> = {}, meshLoginServer?: string) => new MachineAccounts({
    store: db.machines,
    dataKey: KEY,
    signing,
    settings: { url: ROOT_URL, meshLoginServer },
    koala: { of: async (ownerId) => (ownerId === 'bo' ? { url: 'https://bo.people.example', audience: 'inst-bo' } : undefined) },
    followers,
    tell: (deviceId, event, payload) => { told.push([deviceId, event, payload]); return true; },
    mesh,
    now: () => clock,
    ...over,
  });

  const stored = async (id: string) => (await db.machines.getLocalAgentDevices()).find((candidate) => candidate.id === id);

  const joined = async (machines: MachineAccounts, ownerId = 'bo', body: Parameters<MachineAccounts['join']>[1] = { hostname: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64' }) => {
    const { code } = await machines.createJoinCode(ownerId);
    const outcome = await machines.join(code, body);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  };

  beforeEach(async () => {
    db = await make();
    clock = new Date('2026-11-04T12:00:00Z');
    followers = mock<MachineFollowers>();
    followers.joined.mockResolvedValue(undefined);
    followers.removed.mockResolvedValue(undefined);
    followers.changed.mockResolvedValue(undefined);
    told = [];
    mesh = mock<Required<NonNullable<MachineAccountsDeps['mesh']>>>();
    mesh.createPreAuthKey.mockResolvedValue({ key: 'preauth-key' });
  });

  describe('adding a machine to the account, at root', () => {
    it('gives a one-line command from root whose code expires with the hour', async () => {
      const made = await accounts().createJoinCode('bo');
      expect(made.command).toBe(`curl -fsSL ${ROOT_URL}/machine.sh | sh -s -- ${made.code}`);
      expect(Date.parse(made.expiresAt) - clock.getTime()).toBe(MACHINE_CODE_TTL_SECONDS * 1000);
    });

    it('joins the machine once, keeping only a hash of its account token, and tells its Koala', async () => {
      const machines = accounts();
      const { code } = await machines.createJoinCode('bo');
      const outcome = await machines.join(code, { hostname: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64' });
      if (!outcome.ok) throw new Error(outcome.error);
      const { deviceId, env } = outcome.value;
      expect(env).toMatchObject({ KOALA_ROOT_URL: ROOT_URL, KOALA_DEVICE_ID: deviceId, KOALA_ROOT_DIR: '/home/me/koala', MESH_LOGIN_SERVER: '', MESH_AUTH_KEY: '' });
      const saved = (await stored(deviceId))!;
      expect(saved).toMatchObject({ ownerId: 'bo', name: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64', createdAt: clock.toISOString() });
      expect(saved.tokenHash).toBe(createHash('sha256').update(env.KOALA_DEVICE_TOKEN!).digest('hex'));
      expect(JSON.stringify(saved)).not.toContain(env.KOALA_DEVICE_TOKEN);
      expect(Date.parse(saved.expiresAt!) - Date.parse(saved.issuedAt!)).toBe(90 * DAY);
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
      const again = await machines.join(code, { hostname: 'desk', rootDir: '/home/me/work', replaces: first.env.KOALA_DEVICE_TOKEN });
      expect(again.ok && again.value.deviceId).toBe(first.deviceId);
      const replaced = (await stored(first.deviceId))!;
      expect(replaced).toMatchObject({ rootDir: '/home/me/work', createdAt: before.createdAt });
      expect(replaced.tokenHash).not.toBe(before.tokenHash);
      expect(await db.machines.getLocalAgentDevices()).toHaveLength(1);
      expect(followers.joined).not.toHaveBeenCalled();
    });

    it('adds a second machine rather than replace one that is not the person\'s own', async () => {
      const machines = accounts();
      const first = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/x' });
      const stranger = await joined(machines, 'cy', { hostname: 'desk', rootDir: '/x', replaces: first.env.KOALA_DEVICE_TOKEN });
      expect(stranger.deviceId).not.toBe(first.deviceId);
      expect(await db.machines.getLocalAgentDevices()).toHaveLength(2);
    });

    it('hands a machine a key to the private network when root has one, and refuses when it cannot make one', async () => {
      const { env } = await joined(accounts({}, 'https://mesh.koala.example'));
      expect(env).toMatchObject({ MESH_LOGIN_SERVER: 'https://mesh.koala.example', MESH_AUTH_KEY: 'preauth-key' });
      expect(mesh.createPreAuthKey).toHaveBeenCalledWith('bo', { reusable: false, expirySeconds: MACHINE_CODE_TTL_SECONDS });
      const blind = accounts({ mesh: undefined }, 'https://mesh.koala.example');
      const { code } = await blind.createJoinCode('bo');
      expect(await blind.join(code, { rootDir: '/x' })).toEqual({ ok: false, status: 503, error: 'this Koala has a mesh address but cannot reach Headscale to let the machine join it' });
    });

    it('lists a person\'s machines as their Koala needs them, without any token', async () => {
      const machines = accounts();
      const mine = await joined(machines, 'bo');
      await joined(machines, 'cy');
      const listed = await machines.list('bo');
      expect(listed).toEqual([{ id: mine.deviceId, ownerId: 'bo', name: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64', createdAt: clock.toISOString() }]);
    });
  });

  describe('taking an instance\'s machines from before root held them', () => {
    it('keeps each with its id and token hash for the instance\'s owner, once, so running the command again keeps it', async () => {
      const machines = accounts();
      const oldToken = 'a-token-the-instance-gave-before';
      const before = { id: 'old-desk', ownerId: 'someone-else', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-10-01T00:00:00Z', tokenHash: deviceTokenHash(oldToken), issuedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-12-30T00:00:00Z', agents: [{ id: 'x' }] };
      expect(await machines.adoptFrom('bo', [before, { id: 'no-folder', name: 'x', createdAt: 'then' }, 'nonsense'])).toEqual({ adopted: 1 });
      expect(await stored('old-desk')).toEqual({ id: 'old-desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-10-01T00:00:00Z', tokenHash: deviceTokenHash(oldToken), issuedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-12-30T00:00:00Z' });
      expect(await machines.adoptFrom('bo', [{ ...before, name: 'changed' }])).toEqual({ adopted: 0 });
      expect((await stored('old-desk'))?.name).toBe('desk');
      const { code } = await machines.createJoinCode('bo');
      const again = await machines.join(code, { hostname: 'desk', rootDir: '/home/bo/koala', replaces: oldToken });
      expect(again.ok && again.value.deviceId).toBe('old-desk');
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
      const updates = vi.spyOn(db.machines, 'updateLocalAgentDevice');
      await machines.recordMeshIp(deviceId, '100.64.0.9');
      await machines.recordMeshIp('gone', '100.64.0.10');
      expect(updates).not.toHaveBeenCalled();
    });
  });

  describe('a machine\'s account token rotates before it expires', () => {
    it('is given a next token in its last thirty days, once, which replaces the current one when the agent has taken it', async () => {
      const machines = accounts();
      const first = await joined(machines);
      const fresh = (await stored(first.deviceId))!;
      expect(await machines.rotationFor(first.deviceId, 'current')).toBeUndefined();
      clock = new Date(Date.parse(fresh.expiresAt!) - 20 * DAY);
      const retired: string[] = [];
      machines.onTokenRetired((hash) => retired.push(hash));
      const next = await machines.rotationFor(first.deviceId, 'current');
      expect(next).toBeDefined();
      const rotating = (await stored(first.deviceId))!;
      expect(rotating.nextTokenHash).toBe(deviceTokenHash(next!));
      expect(findDeviceByToken([rotating], first.env.KOALA_DEVICE_TOKEN!, KEY, clock)?.id).toBe(first.deviceId);
      expect(findDeviceByToken([rotating], next!, KEY, clock)?.id).toBe(first.deviceId);
      expect(await machines.rotationFor(first.deviceId, 'current')).toBeUndefined();
      await machines.tokenTaken(first.deviceId);
      const promoted = (await stored(first.deviceId))!;
      expect(promoted.nextTokenHash).toBeUndefined();
      expect(promoted.tokenHash).toBe(deviceTokenHash(next!));
      expect(retired).toEqual([fresh.tokenHash]);
      await machines.tokenTaken(first.deviceId);
      expect(retired).toHaveLength(1);
    });

    it('promotes the next token when the agent connects with it before root heard it was taken', async () => {
      const machines = accounts();
      const first = await joined(machines);
      const fresh = (await stored(first.deviceId))!;
      await db.machines.saveLocalAgentDevice({ ...fresh, nextTokenHash: 'n'.repeat(64), nextIssuedAt: fresh.issuedAt, nextExpiresAt: fresh.expiresAt });
      expect(await machines.rotationFor(first.deviceId, 'next')).toBeUndefined();
      expect((await stored(first.deviceId))?.tokenHash).toBe('n'.repeat(64));
    });

    it('gives nothing for a machine that is gone, and a next token to only one of two agents that ask at once', async () => {
      const machines = accounts();
      expect(await machines.rotationFor('gone', 'current')).toBeUndefined();
      const first = await joined(machines);
      clock = new Date(Date.parse((await stored(first.deviceId))!.expiresAt!) - 5 * DAY);
      const [one, two] = await Promise.all([machines.rotationFor(first.deviceId, 'current'), machines.rotationFor(first.deviceId, 'current')]);
      expect([one, two].filter((token) => token !== undefined)).toHaveLength(1);
    });
  });
}
