import { testKeys } from '../../platform/testing/keys.js';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdleGate } from '../../../../local-agent/src/idle-gate.js';
import { SelfUpdate } from '../../../../local-agent/src/self-update.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { issueWorkToken } from '../lib/work-tokens.js';
import { MachineService } from '../services/MachineService.js';
import { servedAgentSockets, until, onlineMachines } from '../testing/wiring-world.js';

const fresh = await emptiedEachTime();

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const root = identityKeysFrom(generateIdentityKey());
const workTokens = { keys: trustedKeys([publicKeyPem(root.publicKey)]), audience: 'inst-1' };
const TOKEN = issueWorkToken(root, { machineId: 'desk', ownerId: 'owner-1', audience: 'inst-1' });
const keys = testKeys('agent-updates-test-secret');

let db: MongoDB;
let machines: MachineService;
let served: string;
let koala: Awaited<ReturnType<typeof servedAgentSockets>>;
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

const shown = async () => (await machines.list('owner-1'))[0]?.agentUpdate;

beforeEach(async () => {
  db = await fresh();
  served = B;
  ending = new Map();
  machines = onlineMachines(db.machines, { bundle: { sha256: async () => served } });
  await db.machines.saveLocalAgentDevice({
    id: 'desk', ownerId: 'owner-1', name: 'desk', rootDir: '/home/person/koala', createdAt: new Date().toISOString(),
  });
  koala = await servedAgentSockets({
    db, payloadKey: keys.payload, dataKey: keys.data, machines, workTokens,
    runs: {
      life: async (runId) => (runId === 'chat-gone-koala-1' ? 'ended' : 'running'),
      closed: (runId) => new Promise((resolve) => ending.set(runId, () => resolve('ended'))),
    },
  });
  url = koala.url;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await koala.close();
});

describe('a machine\'s agent and the bundle Koala serves', () => {
  it('is told the bundle Koala serves when it connects, and shows up to date when it runs it', async () => {
    const { named } = await agent({ bundle: B });
    expect(await named).toEqual({ sha256: B });
    expect(await until(async () => ((await shown())?.state === 'current' ? shown() : undefined))).toEqual({ state: 'current', current: B, running: B });
  });

  it('shows an agent that says nothing about its bundle as too old to update itself', async () => {
    await agent({});
    await until(async () => ((await db.machines.getLocalAgentDevices())[0]?.lastSeenAt ? true : undefined));
    expect(await shown()).toEqual({ state: 'too-old', current: B });
  });

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
  });

  it('keeps the last thing the agent said when recording an earlier one is slower', async () => {
    const { socket } = await agent({ bundle: A });
    const record = machines.recordAgentUpdate.bind(machines);
    let slowOne: () => void = () => undefined;
    const held = new Promise<void>((done) => { slowOne = done; });
    let sent = 0;
    machines.recordAgentUpdate = async (deviceId, raw) => {
      if ((raw as { state?: string }).state === 'updating') await held;
      await record(deviceId, raw);
      sent += 1;
    };
    socket.emit('machine:update', { state: 'updating', bundle: B });
    socket.emit('machine:update', { state: 'failed', bundle: B, reason: 'npm ci failed' });
    await new Promise((done) => setTimeout(done, 200));
    slowOne();
    await until(async () => (sent === 2 ? true : undefined));
    expect(await shown()).toMatchObject({ state: 'failed', reason: 'npm ci failed' });
  });

  it('is behind once Koala serves a newer agent than the one it last reported', async () => {
    await agent({ bundle: A });
    served = A;
    await until(async () => ((await shown())?.state === 'current' ? true : undefined));
    served = B;
  ending = new Map();
    expect(await shown()).toEqual({ state: 'behind', current: B, running: A });
  });
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
  });
});
