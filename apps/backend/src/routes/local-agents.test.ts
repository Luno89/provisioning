import { describe, it, expect, afterAll } from 'vitest';
import type { Socket } from 'socket.io';
import { localAgentsRouter } from './local-agents.js';
import { machinesRouter } from './machines.js';
import { mountRouter, type Harness, TEST_USER } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';
import { decryptValue } from '../lib/crypto.js';
import { askDevice, localAgentStatus, registerDevice, tellDevice, unregisterDevice } from '../lib/local-agent-registry.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { MachineService } from '../services/MachineService.js';
import type { GiteaService } from '../services/GiteaService.js';

const DATA_KEY = 'test-secret';
const URL_OF_KOALA = 'https://koala.example';

let service: MachineService | undefined;
const machinesOf = (db: Database, mesh?: string) => {
  service = new MachineService({
    store: db,
    dataKey: DATA_KEY,
    settings: { url: URL_OF_KOALA, temporalAddress: 'localhost:7233', temporalNamespace: 'default', meshLoginServer: mesh },
    devices: { status: localAgentStatus, tell: tellDevice, ask: askDevice },
    projects: new ProjectRepoService(db, {} as GiteaService, DATA_KEY),
    mesh: { createPreAuthKey: async (ownerId) => ({ key: `preauth-for-${ownerId}` }) },
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
    router.use('/machines', machinesRouter({ machines, bundle: async () => { throw new Error('not in this test'); } }));
    return router;
  },
});

afterAll(async () => { await harness.close(); });

const post = (path: string, body: unknown) => fetch(harness.url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface FakeDevice { socket: Socket; emitted: { event: string; payload: unknown }[] }

const connect = (id: string, answers: Record<string, unknown> = {}): FakeDevice => {
  const emitted: FakeDevice['emitted'] = [];
  const socket = {
    connected: true,
    once: () => socket,
    off: () => socket,
    emit: (event: string, payload: unknown, ack?: (answer: unknown) => void) => {
      emitted.push({ event, payload });
      if (ack) ack(answers[event]);
      return true;
    },
  } as unknown as Socket;
  registerDevice(id, TEST_USER.id, '/x', socket, false);
  return { socket, emitted };
};

describe('adding a machine with the command from My Machines', () => {
  it('gives a one-line command whose code joins the machine to the account once', async () => {
    const made = await post('/api/mesh/local-agents/join-code', {});
    expect(made.status).toBe(201);
    const { code, command, expiresAt } = await made.json() as { code: string; command: string; expiresAt: string };
    expect(command).toBe(`curl -fsSL ${URL_OF_KOALA}/machine.sh | sh -s -- ${code}`);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const joined = await post('/api/machines/join?format=env', { code, hostname: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64' });
    expect(joined.status).toBe(200);
    const env = Object.fromEntries((await joined.text()).trim().split('\n').map((line) => {
      const [name, ...rest] = line.split('=');
      return [name, rest.join('=').replace(/^'|'$/g, '')];
    }));
    expect(env).toMatchObject({ KOALA_BACKEND_URL: URL_OF_KOALA, KOALA_ROOT_DIR: '/home/me/koala', KOALA_TEMPORAL_ADDRESS: 'localhost:7233', KOALA_TEMPORAL_NAMESPACE: 'default', MESH_LOGIN_SERVER: '', MESH_AUTH_KEY: '' });

    const device = (await harness.db.getLocalAgentDevices()).find((candidate) => candidate.id === env.KOALA_DEVICE_ID)!;
    expect(device).toMatchObject({ ownerId: TEST_USER.id, name: 'laptop', rootDir: '/home/me/koala', os: 'Linux x86_64' });
    expect(device.tokenEnc).not.toBe(env.KOALA_DEVICE_TOKEN);
    expect(decryptValue(device.tokenEnc, DATA_KEY)).toBe(env.KOALA_DEVICE_TOKEN);
    const project = (await harness.db.getProjects()).find((candidate) => candidate.executionTarget?.kind === 'local-device' && candidate.executionTarget.deviceId === device.id);
    expect(project?.name).toBe('laptop - koala');

    const again = await post('/api/machines/join', { code, hostname: 'other', rootDir: '/x' });
    expect(again.status).toBe(401);
    expect(await again.text()).toBe('that command has expired or was already used: make a new one on My Machines');
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
    await harness.db.saveLocalAgentDevice({ id: 'dev-mine', ownerId: TEST_USER.id, name: 'Mine', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    await harness.db.saveLocalAgentDevice({ id: 'dev-theirs', ownerId: 'someone-else', name: 'Theirs', rootDir: '/y', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    const mineSocket = connect('dev-mine').socket;
    await service!.recordAgents('dev-mine', [
      { id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found', command: '/usr/bin/gemini', args: ['--acp'], name: 'Gemini CLI', version: '0.61.0', signIn: ['Log in with Google'] },
      { id: 'claude', title: 'Claude Code', state: 'needs-adapter', source: 'found', adapter: '@zed-industries/claude-code-acp' },
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
    await harness.db.saveLocalAgentDevice({ id: 'dev-hand', ownerId: TEST_USER.id, name: 'Hand', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
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
    await harness.db.saveLocalAgentDevice({ id: 'dev-adapter', ownerId: TEST_USER.id, name: 'Adapter', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    await service!.recordAgents('dev-adapter', [
      { id: 'claude', title: 'Claude Code', state: 'needs-adapter', source: 'found', adapter: '@zed-industries/claude-code-acp' },
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
    await harness.db.saveLocalAgentDevice({ id: 'dev-delete-me', ownerId: TEST_USER.id, name: 'Bye', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    await harness.db.saveLocalAgentDevice({ id: 'dev-not-mine', ownerId: 'someone-else', name: 'Not mine', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' });
    expect((await fetch(harness.url('/api/mesh/local-agents/dev-delete-me'), { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(harness.url('/api/mesh/local-agents/dev-not-mine'), { method: 'DELETE' })).status).toBe(404);
    const left = (await harness.db.getLocalAgentDevices()).map((device) => device.id);
    expect(left).not.toContain('dev-delete-me');
    expect(left).toContain('dev-not-mine');
  });
});
