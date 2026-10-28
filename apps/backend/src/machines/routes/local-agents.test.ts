import { createHash } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import type { Socket } from 'socket.io';
import { localAgentsRouter } from './local-agents.js';
import { machinesRouter } from './machines.js';
import { mountRouter, type Harness, TEST_USER } from '../../platform/routes/test-harness.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { askDevice, dropDevice, findDeviceByToken, localAgentStatus, matchDeviceToken, registerDevice, tellDevice, unregisterDevice } from '../lib/local-agent-registry.js';
import { ProjectRepoService } from '../../projects/services/ProjectRepoService.js';
import { MachineService } from '../services/MachineService.js';
import type { GiteaService } from '../../projects/services/GiteaService.js';

const DATA_KEY = 'test-secret';
const URL_OF_KOALA = 'https://koala.example';

let service: MachineService | undefined;
const meshRemoved: { ownerId: string; meshIp: string }[] = [];
const machinesOf = (db: Database, mesh?: string, now?: () => Date) => {
  service = new MachineService({
    ...(now ? { now } : {}),
    store: db.machines,
    dataKey: DATA_KEY,
    settings: { url: URL_OF_KOALA, temporalAddress: 'localhost:7233', temporalNamespace: 'default', meshLoginServer: mesh },
    devices: { status: localAgentStatus, tell: tellDevice, ask: askDevice, drop: dropDevice },
    projects: new ProjectRepoService(db, {} as GiteaService, DATA_KEY),
    mesh: { createPreAuthKey: async (ownerId) => ({ key: `preauth-for-${ownerId}` }), removeNode: async (ownerId, meshIp) => { meshRemoved.push({ ownerId, meshIp }); } },
  });
  return service;
};

const harness: Harness = await mountRouter({
  prefix: '/api',
  router: async (db: Database) => {
    const { Router } = await import('express');
    const router = Router();
    const machines = machinesOf(db);
    router.use('/mesh/local-agents', localAgentsRouter({ machines }));
    router.use('/machines', machinesRouter({ machines, bundle: { path: async () => { throw new Error('not in this test'); }, sha256: async () => 'a'.repeat(64) } }));
    return router;
  },
});

afterAll(async () => { await harness.close(); });

const post = (path: string, body: unknown) => fetch(harness.url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface FakeDevice { socket: Socket; emitted: { event: string; payload: unknown }[]; disconnected: () => boolean }

const connect = (id: string, answers: Record<string, unknown> = {}): FakeDevice => {
  const emitted: FakeDevice['emitted'] = [];
  let disconnected = false;
  const socket = {
    connected: true,
    disconnect: () => { disconnected = true; return socket; },
    once: () => socket,
    off: () => socket,
    emit: (event: string, payload: unknown, ack?: (answer: unknown) => void) => {
      emitted.push({ event, payload });
      if (ack) ack(answers[event]);
      return true;
    },
  } as unknown as Socket;
  registerDevice(id, TEST_USER.id, '/x', socket, false);
  return { socket, emitted, disconnected: () => disconnected };
};

describe('adding a machine with the command from My Machines', () => {
  it('gives a one-line command whose code joins the machine to the account once', async () => {
    const made = await post('/api/mesh/local-agents/join-code', {});
    expect(made.status).toBe(201);
    const { code, command, expiresAt } = await made.json() as { code: string; command: string; expiresAt: string };
    expect(command).toBe(`curl -fsSL ${URL_OF_KOALA}/machine.sh | sh -s -- ${code}`);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const joined = await post('/api/machines/join', { code, hostname: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64' });
    expect(joined.status).toBe(200);
    const { env } = await joined.json() as { env: Record<string, string> };
    expect(env).toMatchObject({ KOALA_BACKEND_URL: URL_OF_KOALA, KOALA_ROOT_DIR: '/home/me/koala', KOALA_TEMPORAL_ADDRESS: 'localhost:7233', KOALA_TEMPORAL_NAMESPACE: 'default', MESH_LOGIN_SERVER: '', MESH_AUTH_KEY: '' });

    const device = (await harness.db.machines.getLocalAgentDevices()).find((candidate) => candidate.id === env.KOALA_DEVICE_ID)!;
    expect(device).toMatchObject({ ownerId: TEST_USER.id, name: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64' });
    expect(device.tokenEnc).toBeUndefined();
    expect(device.tokenHash).toBe(createHash('sha256').update(env.KOALA_DEVICE_TOKEN!).digest('hex'));
    expect(JSON.stringify(device)).not.toContain(env.KOALA_DEVICE_TOKEN);
    const project = (await harness.db.projects.getProjects()).find((candidate) => candidate.executionTarget?.kind === 'local-device' && candidate.executionTarget.deviceId === device.id);
    expect(project?.name).toBe('laptop - koala');

    const again = await post('/api/machines/join', { code, hostname: 'other', rootDir: '/x' });
    expect(again.status).toBe(401);
    expect(await again.text()).toBe('that command has expired or was already used: make a new one on My Machines');
  });

  it('replaces the machine it ran on before when the command runs there again, keeping what was set on it', async () => {
    const codeOf = async () => (await (await post('/api/mesh/local-agents/join-code', {})).json() as { code: string }).code;
    const first = await (await post('/api/machines/join', { code: await codeOf(), hostname: 'desk', rootDir: '/home/me/koala' })).json() as { deviceId: string; env: Record<string, string> };
    const before = (await harness.db.machines.getLocalAgentDevices()).find((device) => device.id === first.deviceId)!;
    await harness.db.machines.saveLocalAgentDevice({ ...before, manualAgents: [{ id: 'pi', command: 'pi', args: ['--rpc'] }] });
    const projects = (await harness.db.projects.getProjects()).length;

    const again = await (await post('/api/machines/join', { code: await codeOf(), hostname: 'desk', rootDir: '/home/me/work', replaces: first.env.KOALA_DEVICE_TOKEN })).json() as { deviceId: string; env: Record<string, string> };

    expect(again.deviceId).toBe(first.deviceId);
    const devices = (await harness.db.machines.getLocalAgentDevices()).filter((device) => device.name === 'desk');
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ rootDir: '/home/me/work', createdAt: before.createdAt, manualAgents: [{ id: 'pi', command: 'pi', args: ['--rpc'] }] });
    expect(devices[0]!.tokenHash).toBe(createHash('sha256').update(again.env.KOALA_DEVICE_TOKEN!).digest('hex'));
    expect(again.env.KOALA_DEVICE_TOKEN).not.toBe(first.env.KOALA_DEVICE_TOKEN);
    expect((await harness.db.projects.getProjects()).length).toBe(projects);

    const stranger = await (await post('/api/machines/join', { code: await codeOf(), hostname: 'desk', rootDir: '/home/me/koala', replaces: 'not-a-token-of-yours' })).json() as { deviceId: string };
    expect(stranger.deviceId).not.toBe(first.deviceId);
  });

  it('refuses a code it never gave, and a folder that is not a full path', async () => {
    expect((await post('/api/machines/join', { code: 'made-up', rootDir: '/x' })).status).toBe(401);
    const { code } = await (await post('/api/mesh/local-agents/join-code', {})).json() as { code: string };
    const relative = await post('/api/machines/join', { code, rootDir: 'koala' });
    expect(relative.status).toBe(400);
    expect((await post('/api/machines/join', { code, rootDir: '/home/me/koala' })).status).toBe(200);
  });

  it('hands a machine a key to the private network when this Koala has one', async () => {
    const meshed = machinesOf(harness.db, 'https://mesh.koala.example');
    const { code } = await meshed.createJoinCode(TEST_USER.id);
    const joined = await meshed.join(code, { hostname: 'box', rootDir: '/srv/koala' });
    expect(joined.ok && joined.value.env).toMatchObject({ MESH_LOGIN_SERVER: 'https://mesh.koala.example', MESH_AUTH_KEY: `preauth-for-${TEST_USER.id}` });
  });
});

describe('a machine\'s agents on My Machines', () => {
  it('lists only the person\'s own machines, with what each machine found and whether it is connected', async () => {
    await harness.db.machines.saveLocalAgentDevice({ id: 'dev-mine', ownerId: TEST_USER.id, name: 'Mine', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    await harness.db.machines.saveLocalAgentDevice({ id: 'dev-theirs', ownerId: 'someone-else', name: 'Theirs', rootDir: '/y', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    const mineSocket = connect('dev-mine').socket;
    await service!.recordAgents('dev-mine', [
      { id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found', command: '/usr/bin/gemini', args: ['--acp'], name: 'Gemini CLI', version: '0.61.0', signIn: ['Log in with Google'] },
      { id: 'claude', title: 'Claude Code', state: 'needs-adapter', source: 'found', adapter: '@agentclientprotocol/claude-agent-acp' },
      { id: 'Not An Id', title: 'x', state: 'ready', source: 'found' },
    ]);

    const body = await (await fetch(harness.url('/api/mesh/local-agents'))).json() as { id: string; online: boolean; agents: { id: string }[]; tokenEnc?: string }[];
    expect(body.map((device) => device.id)).toContain('dev-mine');
    expect(body.map((device) => device.id)).not.toContain('dev-theirs');
    const mine = body.find((device) => device.id === 'dev-mine')!;
    expect(mine.online).toBe(true);
    expect(mine.tokenEnc).toBeUndefined();
    expect(mine.agents.map((agent) => agent.id)).toEqual(['gemini', 'claude']);
    unregisterDevice('dev-mine', mineSocket);
  });

  it('keeps agents added by hand, tells the machine to look again, and refuses ones it cannot run', async () => {
    await harness.db.machines.saveLocalAgentDevice({ id: 'dev-hand', ownerId: TEST_USER.id, name: 'Hand', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    const device = connect('dev-hand');
    const put = (agents: unknown) => fetch(harness.url('/api/mesh/local-agents/dev-hand/agents'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agents }) });

    const saved = await put([{ id: 'antigravity', title: 'Antigravity', command: '/opt/agy/agy_acp_server.par', args: ['--uid='] }]);
    expect(saved.status).toBe(200);
    expect((await saved.json() as { manualAgents: unknown[] }).manualAgents).toEqual([{ id: 'antigravity', title: 'Antigravity', command: '/opt/agy/agy_acp_server.par', args: ['--uid='] }]);
    expect(device.emitted.map((entry) => entry.event)).toEqual(['agents:changed']);
    expect(await service!.manualAgents('dev-hand')).toHaveLength(1);

    const refused = await put([{ id: 'antigravity', command: '' }]);
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: string }).error).toBe('antigravity needs the command that starts it');
    expect((await put([{ id: 'a', command: 'x' }, { id: 'a', command: 'y' }])).status).toBe(400);
    expect((await fetch(harness.url('/api/mesh/local-agents/dev-theirs/agents'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agents: [] }) })).status).toBe(404);
  });

  it('installs an adapter only for an agent that needs one, by asking the machine', async () => {
    await harness.db.machines.saveLocalAgentDevice({ id: 'dev-adapter', ownerId: TEST_USER.id, name: 'Adapter', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    await service!.recordAgents('dev-adapter', [
      { id: 'claude', title: 'Claude Code', state: 'needs-adapter', source: 'found', adapter: '@agentclientprotocol/claude-agent-acp' },
      { id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found' },
    ]);
    const install = (agent: string) => fetch(harness.url(`/api/mesh/local-agents/dev-adapter/agents/${agent}/install`), { method: 'POST' });

    const offline = await install('claude');
    expect(offline.status).toBe(409);
    expect((await offline.json() as { error: string }).error).toBe('Adapter is not connected, so nothing can be installed on it');

    const device = connect('dev-adapter', { 'agents:install': { ok: true, output: 'added 1 package' } });
    const installed = await install('claude');
    expect(installed.status).toBe(200);
    expect(await installed.json()).toEqual({ ok: true, output: 'added 1 package' });
    expect(device.emitted).toEqual([{ event: 'agents:install', payload: { id: 'claude' } }]);

    expect((await install('gemini')).status).toBe(409);
  });

  it('removes a machine the person owns and no one else\'s', async () => {
    await harness.db.machines.saveLocalAgentDevice({ id: 'dev-delete-me', ownerId: TEST_USER.id, name: 'Bye', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    await harness.db.machines.saveLocalAgentDevice({ id: 'dev-not-mine', ownerId: 'someone-else', name: 'Not mine', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    expect((await fetch(harness.url('/api/mesh/local-agents/dev-delete-me'), { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(harness.url('/api/mesh/local-agents/dev-not-mine'), { method: 'DELETE' })).status).toBe(404);
    const left = (await harness.db.machines.getLocalAgentDevices()).map((device) => device.id);
    expect(left).not.toContain('dev-delete-me');
    expect(left).toContain('dev-not-mine');
  });

  it('removing a machine closes its connection, tells it to forget its token, takes it off the mesh and deletes the project it was added with', async () => {
    await harness.db.machines.saveLocalAgentDevice({ id: 'dev-gone', ownerId: TEST_USER.id, name: 'Gone', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    await harness.db.projects.saveProject({ id: 'proj-of-gone', name: 'Gone - x', ownerId: TEST_USER.id, appType: 'local', executionTarget: { kind: 'local-device', deviceId: 'dev-gone' }, createdAt: '2026-01-01T00:00:00Z' });
    await harness.db.projects.saveProject({ id: 'proj-kept', name: 'Kept', ownerId: TEST_USER.id, appType: 'local', executionTarget: { kind: 'local-device', deviceId: 'dev-other' }, createdAt: '2026-01-01T00:00:00Z' });
    await harness.db.projects.saveTree({ id: 'tree-on-gone', ownerId: TEST_USER.id, name: 't', projectIds: ['proj-of-gone', 'proj-kept'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as never);
    const device = connect('dev-gone');
    await service!.recordMeshIp('dev-gone', '100.64.0.9');
    await service!.recordMeshIp('dev-gone', '10.0.0.1');
    expect((await harness.db.machines.getLocalAgentDevices()).find((entry) => entry.id === 'dev-gone')?.meshIp).toBe('100.64.0.9');

    expect((await fetch(harness.url('/api/mesh/local-agents/dev-gone'), { method: 'DELETE' })).status).toBe(200);

    expect(device.emitted.map((entry) => entry.event)).toContain('machine:removed');
    expect(device.disconnected()).toBe(true);
    expect(localAgentStatus('dev-gone').online).toBe(false);
    expect(meshRemoved).toEqual([{ ownerId: TEST_USER.id, meshIp: '100.64.0.9' }]);
    const projects = (await harness.db.projects.getProjects()).map((project) => project.id);
    expect(projects).not.toContain('proj-of-gone');
    expect(projects).toContain('proj-kept');
    expect((await harness.db.projects.getTrees()).find((tree) => tree.id === 'tree-on-gone')?.projectIds).toEqual(['proj-kept']);
  });
});

describe('a device token rotates before it expires', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const devices = () => harness.db.machines.getLocalAgentDevices();
  const codeOf = async () => ((await (await post('/api/mesh/local-agents/join-code', {})).json()) as { code: string }).code;

  it('is given ninety days when the machine joins, and a next token in its last thirty, which replaces it once taken', async () => {
    const joined = await (await post('/api/machines/join', { code: await codeOf(), hostname: 'rotating', rootDir: '/home/me/rotating' })).json() as { deviceId: string; env: Record<string, string> };
    expect(joined.env.KOALA_AGENT_SHA256).toBe('a'.repeat(64));
    const fresh = (await devices()).find((d) => d.id === joined.deviceId)!;
    expect(Date.parse(fresh.expiresAt!) - Date.parse(fresh.issuedAt!)).toBe(90 * DAY);

    const later = new Date(Date.parse(fresh.expiresAt!) - 20 * DAY);
    const machines = machinesOf(harness.db, undefined, () => later);
    const retired: string[] = [];
    machines.onTokenRetired((hash) => retired.push(hash));
    const next = await machines.rotationFor(joined.deviceId, 'current');
    expect(next).toBeDefined();
    const rotating = (await devices()).find((d) => d.id === joined.deviceId)!;
    expect(rotating.nextTokenHash).toBe(createHash('sha256').update(next!).digest('hex'));
    expect(findDeviceByToken([rotating], joined.env.KOALA_DEVICE_TOKEN!, DATA_KEY, later)?.id).toBe(joined.deviceId);
    expect(findDeviceByToken([rotating], next!, DATA_KEY, later)?.id).toBe(joined.deviceId);
    expect(await machines.rotationFor(joined.deviceId, 'current')).toBeUndefined();

    await machines.tokenTaken(joined.deviceId);
    const promoted = (await devices()).find((d) => d.id === joined.deviceId)!;
    expect(promoted.nextTokenHash).toBeUndefined();
    expect(retired).toEqual([fresh.tokenHash]);
    expect(findDeviceByToken([promoted], joined.env.KOALA_DEVICE_TOKEN!, DATA_KEY, later)).toBeUndefined();
    expect(findDeviceByToken([promoted], next!, DATA_KEY, later)?.id).toBe(joined.deviceId);
    expect(Date.parse(promoted.expiresAt!) - later.getTime()).toBe(90 * DAY);

    const expired = new Date(Date.parse(promoted.expiresAt!) + 1);
    expect(findDeviceByToken([promoted], next!, DATA_KEY, expired)).toBeUndefined();
    expect(matchDeviceToken([promoted], next!, DATA_KEY, expired)).toMatchObject({ via: 'current', expired: true });
    expect((await machinesOf(harness.db, undefined, () => expired).list(TEST_USER.id)).find((m) => m.id === joined.deviceId)?.tokenExpired).toBe(true);
    expect((await machines.list(TEST_USER.id)).find((m) => m.id === joined.deviceId)?.tokenExpired).toBe(false);
  });

  it('an agent that kept the next token before Koala heard so is promoted when it connects with it', async () => {
    const machines = machinesOf(harness.db);
    const joined = await machines.join(await codeOf(), { hostname: 'box', rootDir: '/srv/koala' });
    const id = joined.ok ? joined.value.deviceId : '';
    const device = (await devices()).find((d) => d.id === id)!;
    await harness.db.machines.saveLocalAgentDevice({ ...device, nextTokenHash: 'n'.repeat(64), nextIssuedAt: device.issuedAt, nextExpiresAt: device.expiresAt });
    expect(await machines.rotationFor(id, 'next')).toBeUndefined();
    const after = (await devices()).find((d) => d.id === id)!;
    expect(after.tokenHash).toBe('n'.repeat(64));
    expect(after.nextTokenHash).toBeUndefined();
  });

  it('running the command again replaces a machine whose token has expired, rather than adding a second', async () => {
    const machines = machinesOf(harness.db, undefined, () => new Date('2020-01-01T00:00:00Z'));
    const joined = await machines.join(await codeOf(), { hostname: 'old', rootDir: '/srv/old' });
    const token = joined.ok ? joined.value.env.KOALA_DEVICE_TOKEN! : '';
    const id = joined.ok ? joined.value.deviceId : '';
    expect(findDeviceByToken(await devices(), token, DATA_KEY)).toBeUndefined();
    const again = await machinesOf(harness.db).join(await codeOf(), { hostname: 'old', rootDir: '/srv/old', replaces: token });
    expect(again.ok && again.value.deviceId).toBe(id);
  });
});
