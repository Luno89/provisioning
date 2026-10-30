import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdleGate } from '../../../../local-agent/src/idle-gate.js';
import { SelfUpdate } from '../../../../local-agent/src/self-update.js';
import { loadKeys } from '../../platform/lib/keys.js';
import { roleFromEnv } from '../../platform/lib/platform-role.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { deviceTokenHash, tokenLifetime } from '../lib/device-tokens.js';
import { MachineService } from '../services/MachineService.js';
import { wireSockets, type SocketsWiringDeps } from './sockets.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const TOKEN = 'the-token-the-machine-joined-with-0123456789';
const keys = loadKeys({ JWT_SECRET: 'agent-updates-test-secret' });

let db: MongoDB;
let machines: MachineService;
let served: string;
let server: http.Server;
let io: SocketServer;
let url = '';
let ending: Map<string, () => void>;
const clients: ClientSocket[] = [];

function agent(auth: Record<string, unknown>): Promise<{ socket: ClientSocket; named: Promise<unknown> }> {
  const socket = connect(`${url}/agent`, { auth: { token: TOKEN, ...auth }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  const named = new Promise<unknown>((resolve) => socket.once('machine:bundle', resolve));
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve({ socket, named }));
    socket.once('connect_error', reject);
  });
}

async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
}

const shown = async () => (await machines.list('owner-1'))[0]?.agentUpdate;

beforeEach(async () => {
  db = await testDatabase();
  served = B;
  ending = new Map();
  machines = new MachineService({
    store: db.machines,
    dataKey: keys.data,
    settings: { url: 'http://koala.test', temporalAddress: 'localhost:7234', temporalNamespace: 'default' },
    devices: { status: () => ({ online: true }) } as never,
    projects: { register: async () => { throw new Error('not used'); } },
    bundle: { sha256: async () => served },
  });
  await db.machines.saveLocalAgentDevice({
    id: 'desk', ownerId: 'owner-1', name: 'desk', rootDir: '/home/person/koala', createdAt: new Date().toISOString(),
    tokenHash: deviceTokenHash(TOKEN), ...tokenLifetime(new Date()),
  });
  server = http.createServer();
  io = new SocketServer(server);
  wireSockets({
    io, db, role: roleFromEnv({}), env: {}, payloadKey: keys.payload, dataKey: keys.data,
    auth: { sessionFromCookie: async () => undefined, securedFor: () => false, principalFor: () => undefined } as unknown as SocketsWiringDeps['auth'],
    sessionSockets: { track: () => undefined, forget: () => undefined },
    machines, clusters: {} as never, apps: {} as never, infra: {} as never,
    telemetry: { relay: async () => ({ ok: true }) } as never,
    runs: {
      life: async (runId) => (runId === 'chat-gone-koala-1' ? 'ended' : 'running'),
      closed: (runId) => new Promise((resolve) => ending.set(runId, () => resolve('ended'))),
    },
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  io.close();
  await new Promise<void>((done) => server.close(() => done()));
});

describe('a machine\'s agent and the bundle Koala serves', () => {
  it('is told the bundle Koala serves when it connects, and shows up to date when it runs it', async () => {
    const { named } = await agent({ bundle: B });
    expect(await named).toEqual({ sha256: B });
    expect(await until(async () => ((await shown())?.state === 'current' ? shown() : undefined))).toEqual({ state: 'current', current: B, running: B });
  }, 30_000);

  it('shows an agent that says nothing about its bundle as too old to update itself', async () => {
    await agent({});
    await until(async () => ((await db.machines.getLocalAgentDevices())[0]?.lastSeenAt ? true : undefined));
    expect(await shown()).toEqual({ state: 'too-old', current: B });
  }, 30_000);

  it('shows what the agent says as it follows a newer bundle: waiting while busy, then why it failed', async () => {
    const { socket, named } = await agent({ bundle: A });
    const gate = new IdleGate();
    const busy = gate.hold('a session of gemini');
    const updates = new SelfUpdate({
      own: A, service: 'systemd', gate,
      prepare: () => Promise.reject(new Error('npm ci failed: npm error network')),
      discard: async () => undefined, quiesce: async () => undefined, resume: async () => undefined, swap: () => undefined, restart: () => undefined,
      report: (report) => socket.emit('machine:update', report),
      log: () => undefined,
    });
    const following = updates.named(await named);
    expect(await until(async () => ((await shown())?.state === 'waiting' ? shown() : undefined)))
      .toMatchObject({ state: 'waiting', current: B, running: A, busyWith: ['a session of gemini'] });
    busy();
    await following;
    expect(await until(async () => ((await shown())?.state === 'failed' ? shown() : undefined)))
      .toMatchObject({ state: 'failed', current: B, running: A, reason: 'npm ci failed: npm error network' });
  }, 30_000);

  it('is behind once Koala serves a newer agent than the one it last reported', async () => {
    await agent({ bundle: A });
    served = A;
    await until(async () => ((await shown())?.state === 'current' ? true : undefined));
    served = B;
  ending = new Map();
    expect(await shown()).toEqual({ state: 'behind', current: B, running: A });
  }, 30_000);
});

describe('a machine\'s sessions and the runs that hold them', () => {
  it('is told when a run it says holds a session has ended, or ends later', async () => {
    const { socket } = await agent({ bundle: B });
    const ended: string[] = [];
    socket.on('machine:run-ended', ({ runId }: { runId: string }) => ended.push(runId));
    socket.emit('machine:runs', { runIds: ['chat-1-koala-1', 'chat-gone-koala-1'] });
    await until(async () => (ended.includes('chat-gone-koala-1') && ending.has('chat-1-koala-1') ? true : undefined));
    expect(ended).toEqual(['chat-gone-koala-1']);
    ending.get('chat-1-koala-1')!();
    await until(async () => (ended.length === 2 ? true : undefined));
    expect(ended).toEqual(['chat-gone-koala-1', 'chat-1-koala-1']);
  }, 30_000);
});
