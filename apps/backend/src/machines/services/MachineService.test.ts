import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { LocalAgentDeviceMetadata } from '../../platform/index.js';
import { deviceTokenHash, tokenLifetime } from '../lib/device-tokens.js';
import { findDeviceByToken } from '../lib/local-agent-registry.js';
import { MACHINE_CODE_TTL_SECONDS } from '../lib/machines.js';
import { MachineService, type MachineDevices, type MachineDeps } from './MachineService.js';

const DAY = 24 * 60 * 60 * 1000;
const URL_OF_KOALA = 'https://koala.example';
const KEY = 'test-secret';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

let db: Database;
let devices: ReturnType<typeof mock<MachineDevices>>;
let projects: ReturnType<typeof mock<Required<MachineDeps['projects']>>>;
let mesh: ReturnType<typeof mock<Required<NonNullable<MachineDeps['mesh']>>>>;
let clock: Date;

const service = (over: Partial<MachineDeps> = {}, meshLoginServer?: string) => new MachineService({
  store: db.machines,
  dataKey: KEY,
  settings: { url: URL_OF_KOALA, temporalAddress: 'localhost:7233', temporalNamespace: 'default', meshLoginServer },
  devices,
  projects,
  mesh,
  now: () => clock,
  ...over,
});

const device = (over: Partial<LocalAgentDeviceMetadata> = {}): LocalAgentDeviceMetadata => ({
  id: 'dev-1', ownerId: 'bo', name: 'Desk', rootDir: '/x', tokenHash: 'h'.repeat(64), createdAt: '2026-01-01T00:00:00Z', ...tokenLifetime(clock), ...over,
});

const stored = async (id: string) => (await db.machines.getLocalAgentDevices()).find((candidate) => candidate.id === id);

const joined = async (machines: MachineService, ownerId = 'bo', body: Parameters<MachineService['join']>[1] = { hostname: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64' }) => {
  const { code } = await machines.createJoinCode(ownerId);
  const outcome = await machines.join(code, body);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value;
};

beforeEach(() => {
  db = memoryDatabase();
  clock = new Date('2026-10-30T12:00:00Z');
  devices = mock<MachineDevices>();
  devices.status.mockReturnValue({ online: false });
  projects = mock<Required<MachineDeps['projects']>>();
  projects.register.mockResolvedValue({ id: 'proj-1' } as never);
  mesh = mock<Required<NonNullable<MachineDeps['mesh']>>>();
  mesh.createPreAuthKey.mockResolvedValue({ key: 'preauth-key' });
});

describe('adding a machine with the command from My Machines', () => {
  it('gives a one-line command whose code expires with the hour', async () => {
    const made = await service().createJoinCode('bo');
    expect(made.command).toBe(`curl -fsSL ${URL_OF_KOALA}/machine.sh | sh -s -- ${made.code}`);
    expect(Date.parse(made.expiresAt) - clock.getTime()).toBe(MACHINE_CODE_TTL_SECONDS * 1000);
  });

  it('joins the machine to the account once, keeping only a hash of its token and making it a project', async () => {
    const machines = service();
    const { code } = await machines.createJoinCode('bo');
    const outcome = await machines.join(code, { hostname: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64' });
    expect(outcome.ok).toBe(true);
    const { deviceId, env } = outcome.ok ? outcome.value : { deviceId: '', env: {} as Record<string, string> };
    expect(env).toMatchObject({
      KOALA_BACKEND_URL: URL_OF_KOALA, KOALA_DEVICE_ID: deviceId, KOALA_ROOT_DIR: '/home/me/koala', KOALA_TEMPORAL_ADDRESS: 'localhost:7233', KOALA_TEMPORAL_NAMESPACE: 'default', MESH_LOGIN_SERVER: '', MESH_AUTH_KEY: '',
    });
    const saved = (await stored(deviceId))!;
    expect(saved).toMatchObject({ ownerId: 'bo', name: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64', createdAt: clock.toISOString() });
    expect(saved.tokenHash).toBe(createHash('sha256').update(env.KOALA_DEVICE_TOKEN!).digest('hex'));
    expect(JSON.stringify(saved)).not.toContain(env.KOALA_DEVICE_TOKEN);
    expect(Date.parse(saved.expiresAt!) - Date.parse(saved.issuedAt!)).toBe(90 * DAY);
    expect(projects.register).toHaveBeenCalledWith('bo', 'laptop - koala', { executionTarget: { kind: 'local-device', deviceId } });

    const again = await machines.join(code, { hostname: 'other', rootDir: '/x' });
    expect(again).toEqual({ ok: false, status: 401, error: 'that command has expired or was already used: make a new one on My Machines' });
  });

  it('refuses a code it never gave, one that has run out, and a request without a code or a full path', async () => {
    const machines = service();
    expect(await machines.join(undefined, { rootDir: '/x' })).toEqual({ ok: false, status: 400, error: 'send the code from My Machines as "code"' });
    expect(await machines.join('', { rootDir: '/x' })).toMatchObject({ status: 400 });
    expect(await machines.join('made-up', { rootDir: '/x' })).toMatchObject({ ok: false, status: 401 });
    const { code } = await machines.createJoinCode('bo');
    expect(await machines.join(code, { rootDir: 'koala' })).toEqual({ ok: false, status: 400, error: 'send the folder Koala may work in as "rootDir", a full path' });
    expect(await machines.join(code, {})).toMatchObject({ status: 400 });
    clock = new Date(clock.getTime() + (MACHINE_CODE_TTL_SECONDS + 1) * 1000);
    expect(await machines.join(code, { rootDir: '/x' })).toMatchObject({ ok: false, status: 401 });
  });

  it('names a machine "machine" when it sends no name, and shortens what it sends', async () => {
    const machines = service();
    const nameless = await joined(machines, 'bo', { rootDir: '/home/me/koala' });
    expect((await stored(nameless.deviceId))?.name).toBe('machine');
    const long = await joined(machines, 'bo', { hostname: ` ${'h'.repeat(200)} `, rootDir: '/', os: '  ' });
    const saved = (await stored(long.deviceId))!;
    expect(saved.name).toHaveLength(80);
    expect(saved.os).toBeUndefined();
    expect(projects.register).toHaveBeenLastCalledWith('bo', `${'h'.repeat(80)} - /`, expect.anything() as never);
  });

  it('still joins when the machine\'s project could not be made', async () => {
    projects.register.mockRejectedValue(new Error('no repository'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcome = await joined(service());
    expect(await stored(outcome.deviceId)).toBeDefined();
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('no repository'));
    warned.mockRestore();
  });

  it('replaces the machine it ran on before when the command runs there again, keeping what was set on it and adding no second project', async () => {
    const machines = service();
    const first = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/home/me/koala' });
    const before = (await stored(first.deviceId))!;
    await db.machines.saveLocalAgentDevice({ ...before, manualAgents: [{ id: 'pi', command: 'pi', args: ['--rpc'] }] });
    projects.register.mockClear();

    const { code } = await machines.createJoinCode('bo');
    const again = await machines.join(code, { hostname: 'desk', rootDir: '/home/me/work', replaces: first.env.KOALA_DEVICE_TOKEN });
    expect(again.ok && again.value.deviceId).toBe(first.deviceId);
    const replaced = (await stored(first.deviceId))!;
    expect(replaced).toMatchObject({ rootDir: '/home/me/work', createdAt: before.createdAt, manualAgents: [{ id: 'pi', command: 'pi', args: ['--rpc'] }] });
    expect(replaced.tokenHash).not.toBe(before.tokenHash);
    expect(await db.machines.getLocalAgentDevices()).toHaveLength(1);
    expect(projects.register).not.toHaveBeenCalled();
  });

  it('adds a second machine rather than replace one that is not the person\'s own', async () => {
    const machines = service();
    const first = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/x' });
    const stranger = await joined(machines, 'cy', { hostname: 'desk', rootDir: '/x', replaces: first.env.KOALA_DEVICE_TOKEN });
    expect(stranger.deviceId).not.toBe(first.deviceId);
    expect(await db.machines.getLocalAgentDevices()).toHaveLength(2);
    const unknown = await joined(machines, 'bo', { hostname: 'desk', rootDir: '/x', replaces: 'not-a-token' });
    expect(unknown.deviceId).not.toBe(first.deviceId);
  });

  it('hands a machine a key to the private network when this Koala has one, and refuses when it cannot make one', async () => {
    const meshed = service({}, 'https://mesh.koala.example');
    const { env } = await joined(meshed);
    expect(env).toMatchObject({ MESH_LOGIN_SERVER: 'https://mesh.koala.example', MESH_AUTH_KEY: 'preauth-key' });
    expect(mesh.createPreAuthKey).toHaveBeenCalledWith('bo', { reusable: false, expirySeconds: MACHINE_CODE_TTL_SECONDS });

    const blind = service({ mesh: undefined }, 'https://mesh.koala.example');
    const { code } = await blind.createJoinCode('bo');
    expect(await blind.join(code, { rootDir: '/x' })).toEqual({ ok: false, status: 503, error: 'this Koala has a mesh address but cannot reach Headscale to let the machine join it' });
  });

  it('gives no mesh key when the mesh address is this computer\'s own', async () => {
    const { env } = await joined(service({}, 'http://localhost:8080'));
    expect(env).toMatchObject({ MESH_LOGIN_SERVER: '', MESH_AUTH_KEY: '' });
    expect(mesh.createPreAuthKey).not.toHaveBeenCalled();
  });
});

describe('what My Machines shows of a machine', () => {
  it('lists only the person\'s own machines, with whether each is connected, and never a token', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'mine', lastSeenAt: '2026-10-30T11:00:00Z', os: 'Linux', agentsAt: '2026-10-30T11:00:00Z' }));
    await db.machines.saveLocalAgentDevice(device({ id: 'theirs', ownerId: 'cy' }));
    devices.status.mockImplementation((id) => (id === 'mine' ? { online: true, connectedAt: '2026-10-30T10:00:00Z', containerMode: true } : { online: false }));
    const listed = await service().list('bo');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'mine', online: true, connectedAt: '2026-10-30T10:00:00Z', containerMode: true, os: 'Linux', lastSeenAt: '2026-10-30T11:00:00Z', tokenExpired: false, agents: [], manualAgents: [] });
    expect(JSON.stringify(listed)).not.toContain('tokenHash');
  });

  it('says a machine\'s token has expired once its time is up', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'old' }));
    clock = new Date(clock.getTime() + 91 * DAY);
    expect((await service().list('bo'))[0]!.tokenExpired).toBe(true);
  });

  it('says where each agent stands against the bundle Koala serves', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'old', lastSeenAt: '2026-10-30T11:00:00Z', agentBundle: A }));
    const served = service({ bundle: { sha256: async () => B } });
    expect((await served.list('bo'))[0]!.agentUpdate).toMatchObject({ state: 'behind', current: B, running: A });
    const plain = service();
    expect((await plain.list('bo'))[0]!.agentUpdate).toBeUndefined();
  });

  it('says which bundle Koala serves, or that it is not known, saying why', async () => {
    expect(await service().currentBundle()).toBeUndefined();
    expect(await service({ bundle: { sha256: async () => A } }).currentBundle()).toBe(A);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await service({ bundle: { sha256: async () => { throw new Error('no tarball'); } } }).currentBundle()).toBeUndefined();
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('no tarball'));
    warned.mockRestore();
  });

  it('refuses a choice of a machine that is not the person\'s, one without the agent, and one that is not ready or connected', async () => {
    const machines = service();
    await db.machines.saveLocalAgentDevice(device({ id: 'mine', agents: [{ id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found' }, { id: 'claude', title: 'Claude Code', state: 'needs-adapter', source: 'found' }] }));
    expect(await machines.choiceProblem('cy', { deviceId: 'mine', agent: 'gemini' })).toBe('that machine is not one of yours any more; pick another on My Machines or in the model list');
    expect(await machines.choiceProblem('bo', { deviceId: 'mine', agent: 'goose' })).toBe('Desk has no agent called goose');
    expect(await machines.choiceProblem('bo', { deviceId: 'mine', agent: 'claude' })).toContain('is not ready');
    expect(await machines.choiceProblem('bo', { deviceId: 'mine', agent: 'gemini' })).toBe('Desk is not connected, so Gemini CLI cannot answer');
    devices.status.mockReturnValue({ online: true });
    expect(await machines.choiceProblem('bo', { deviceId: 'mine', agent: 'gemini' })).toBeUndefined();
  });

  it('records the agents a machine found, as many as are well formed, and when', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'mine' }));
    const machines = service();
    await machines.recordAgents('mine', [
      { id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found', command: '/usr/bin/gemini', args: ['--acp'], name: 'Gemini CLI', version: '0.61.0' },
      { id: 'Not An Id', title: 'x', state: 'ready', source: 'found' },
    ]);
    const saved = (await stored('mine'))!;
    expect(saved.agents?.map((agent) => agent.id)).toEqual(['gemini']);
    expect(saved.agentsAt).toBe(clock.toISOString());
    await machines.recordAgents('gone', []);
    expect(await stored('gone')).toBeUndefined();
  });

  it('notes when a machine was last seen', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'mine' }));
    await service().seen('mine');
    expect((await stored('mine'))?.lastSeenAt).toBe(clock.toISOString());
  });

  it('records the bundle an agent runs, forgetting it when the agent names none, and what its self-update reported', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'mine' }));
    const machines = service();
    await machines.recordAgentBundle('mine', { bundle: A });
    expect((await stored('mine'))?.agentBundle).toBe(A);
    await machines.recordAgentBundle('mine', {});
    expect((await stored('mine'))?.agentBundle).toBeUndefined();

    await machines.recordAgentUpdate('mine', { state: 'failed', bundle: B, reason: 'npm ci failed' });
    expect((await stored('mine'))?.agentUpdate).toMatchObject({ state: 'failed', bundle: B, reason: 'npm ci failed', at: clock.toISOString() });
    await machines.recordAgentUpdate('mine', { state: 'nonsense', bundle: B });
    await machines.recordAgentUpdate('mine', null);
    expect((await stored('mine'))?.agentUpdate?.state).toBe('failed');
  });
});

describe('the agents added to a machine by hand', () => {
  it('keeps them, tells the machine to look again, and shows them at once', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'mine' }));
    devices.status.mockReturnValue({ online: true });
    const machines = service();
    const outcome = await machines.setManualAgents('bo', 'mine', [{ id: 'antigravity', title: 'Antigravity', command: '/opt/agy/agy_acp_server.par', args: ['--uid='] }]);
    expect(outcome).toMatchObject({ ok: true, value: { manualAgents: [{ id: 'antigravity', title: 'Antigravity', command: '/opt/agy/agy_acp_server.par', args: ['--uid='] }] } });
    expect(devices.tell).toHaveBeenCalledWith('mine', 'agents:changed');
    expect(await machines.manualAgents('mine')).toHaveLength(1);
    expect(await machines.manualAgents('gone')).toEqual([]);
  });

  it('refuses ones it cannot run, and a machine that is not the person\'s', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'mine' }));
    const machines = service();
    expect(await machines.setManualAgents('bo', 'mine', [{ id: 'antigravity', command: '' }])).toEqual({ ok: false, status: 400, error: 'antigravity needs the command that starts it' });
    expect(await machines.setManualAgents('bo', 'mine', [{ id: 'a', command: 'x' }, { id: 'a', command: 'y' }])).toMatchObject({ ok: false, status: 400 });
    expect(await machines.setManualAgents('cy', 'mine', [])).toEqual({ ok: false, status: 404, error: 'no such machine' });
    expect(devices.tell).not.toHaveBeenCalled();
  });
});

describe('installing an adapter on a machine', () => {
  const waiting = () => device({ id: 'mine', name: 'Adapter', agents: [
    { id: 'claude', title: 'Claude Code', state: 'needs-adapter', source: 'found', adapter: '@agentclientprotocol/claude-agent-acp' },
    { id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found' },
  ] });

  it('asks the machine to install it, and says what the machine answered', async () => {
    await db.machines.saveLocalAgentDevice(waiting());
    devices.status.mockReturnValue({ online: true });
    devices.ask.mockResolvedValue({ ok: true, output: 'added 1 package' });
    expect(await service().installAdapter('bo', 'mine', 'claude')).toEqual({ ok: true, value: { ok: true, output: 'added 1 package' } });
    expect(devices.ask).toHaveBeenCalledWith('mine', 'bo', 'agents:install', { id: 'claude' });
  });

  it('reports a machine that answers with nothing useful as having installed nothing', async () => {
    await db.machines.saveLocalAgentDevice(waiting());
    devices.status.mockReturnValue({ online: true });
    devices.ask.mockResolvedValue(undefined);
    expect(await service().installAdapter('bo', 'mine', 'claude')).toEqual({ ok: true, value: { ok: false, output: '' } });
  });

  it('refuses a machine that is not the person\'s, an agent that needs nothing, and a machine that is not connected', async () => {
    await db.machines.saveLocalAgentDevice(waiting());
    const machines = service();
    expect(await machines.installAdapter('cy', 'mine', 'claude')).toEqual({ ok: false, status: 404, error: 'no such machine' });
    expect(await machines.installAdapter('bo', 'mine', 'gemini')).toEqual({ ok: false, status: 409, error: 'gemini has nothing waiting to be installed on Adapter' });
    expect(await machines.installAdapter('bo', 'mine', 'claude')).toEqual({ ok: false, status: 409, error: 'Adapter is not connected, so nothing can be installed on it' });
    expect(devices.ask).not.toHaveBeenCalled();
  });
});

describe('removing a machine', () => {
  it('deletes it, closes its connection, takes it off the mesh and deletes the project it was added with', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'gone', meshIp: '100.64.0.9' }));
    projects.removeFor.mockResolvedValue(undefined);
    mesh.removeNode.mockResolvedValue(undefined);
    expect(await service().remove('bo', 'gone')).toBe(true);
    expect(await stored('gone')).toBeUndefined();
    expect(devices.drop).toHaveBeenCalledWith('gone');
    expect(mesh.removeNode).toHaveBeenCalledWith('bo', '100.64.0.9');
    expect(projects.removeFor).toHaveBeenCalledWith('bo', 'gone');
  });

  it('removes no one else\'s machine', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'theirs', ownerId: 'cy' }));
    expect(await service().remove('bo', 'theirs')).toBe(false);
    expect(await service().remove('bo', 'nothing')).toBe(false);
    expect(await stored('theirs')).toBeDefined();
    expect(devices.drop).not.toHaveBeenCalled();
  });

  it('is removed even when the mesh or the project cannot be cleaned up, saying so', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'gone', meshIp: '100.64.0.9' }));
    mesh.removeNode.mockRejectedValue(new Error('headscale is down'));
    projects.removeFor.mockRejectedValue(new Error('no project'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await service().remove('bo', 'gone')).toBe(true);
    expect(await stored('gone')).toBeUndefined();
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('headscale is down'));
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('no project'));
    warned.mockRestore();
  });

  it('skips the mesh for a machine that never joined it, and the project where there is no way to remove it', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'plain' }));
    const bare = service({ mesh: undefined, projects: { register: async () => ({ id: 'p' }) as never } });
    expect(await bare.remove('bo', 'plain')).toBe(true);
    expect(mesh.removeNode).not.toHaveBeenCalled();
  });

  it('notes the mesh address a machine reports, and only a real one, once', async () => {
    await db.machines.saveLocalAgentDevice(device({ id: 'mine' }));
    const machines = service();
    await machines.recordMeshIp('mine', '100.64.0.9');
    await machines.recordMeshIp('mine', '10.0.0.1');
    await machines.recordMeshIp('mine', undefined);
    expect((await stored('mine'))?.meshIp).toBe('100.64.0.9');
    const updates = vi.spyOn(db.machines, 'updateLocalAgentDevice');
    await machines.recordMeshIp('mine', '100.64.0.9');
    await machines.recordMeshIp('gone', '100.64.0.10');
    expect(updates).not.toHaveBeenCalled();
  });
});

describe('a machine\'s token rotates before it expires', () => {
  it('is given a next token in its last thirty days, once, which replaces the current one when the agent has taken it', async () => {
    const machines = service();
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
    expect(Date.parse(promoted.expiresAt!) - clock.getTime()).toBe(90 * DAY);
    await machines.tokenTaken(first.deviceId);
    expect(retired).toHaveLength(1);
  });

  it('promotes the next token when the agent connects with it before Koala heard it was taken', async () => {
    const machines = service();
    const first = await joined(machines);
    const fresh = (await stored(first.deviceId))!;
    await db.machines.saveLocalAgentDevice({ ...fresh, nextTokenHash: 'n'.repeat(64), nextIssuedAt: fresh.issuedAt, nextExpiresAt: fresh.expiresAt });
    expect(await machines.rotationFor(first.deviceId, 'next')).toBeUndefined();
    const after = (await stored(first.deviceId))!;
    expect(after.tokenHash).toBe('n'.repeat(64));
    expect(after.nextTokenHash).toBeUndefined();
  });

  it('gives nothing for a machine that is gone, and promotes nothing when no next token waits', async () => {
    const machines = service();
    expect(await machines.rotationFor('gone', 'current')).toBeUndefined();
    expect(await machines.rotationFor('gone', 'next')).toBeUndefined();
    const first = await joined(machines);
    await machines.tokenTaken(first.deviceId);
    await machines.tokenTaken('gone');
    expect((await stored(first.deviceId))?.nextTokenHash).toBeUndefined();
  });

  it('gives a next token to only one of two agents that ask at once', async () => {
    const machines = service();
    const first = await joined(machines);
    clock = new Date(Date.parse((await stored(first.deviceId))!.expiresAt!) - 5 * DAY);
    const [one, two] = await Promise.all([machines.rotationFor(first.deviceId, 'current'), machines.rotationFor(first.deviceId, 'current')]);
    expect([one, two].filter((token) => token !== undefined)).toHaveLength(1);
  });
});
