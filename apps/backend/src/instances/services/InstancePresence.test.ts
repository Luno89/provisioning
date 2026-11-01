import http from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { InstanceRecord } from '../lib/instances.js';
import { InstancePresence } from './InstancePresence.js';
import { RootPresence } from './RootPresence.js';
import { wireInstancePresence } from '../wiring/instances.js';

const GRACE = 300;
const own: InstanceRecord = { id: 'inst-own', ownerId: 'person', url: 'https://own.example', createdAt: '', updatedAt: '', status: 'ready', name: 'own' };
const pooled: InstanceRecord = { ...own, id: 'inst-pool', ownerId: 'trier', name: 'pooled', pool: { ports: { backend: 1, edge: 2, registry: 3 }, startedAt: '', trialEndsAt: '' } };

const until = async <T>(look: () => T | undefined | Promise<T | undefined>): Promise<T> => {
  for (;;) {
    const found = await look();
    if (found !== undefined && found !== false) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

let db: MongoDB;
let server: http.Server;
let io: Server;
let port: number;
let presence: InstancePresence;
let mailed: Array<{ to: string; subject: string }>;
let operators: string[];
const clients: RootPresence[] = [];

async function startRoot(onPort = 0): Promise<void> {
  server = http.createServer();
  io = new Server(server, { pingInterval: 10_000, pingTimeout: 10_000 });
  presence = new InstancePresence({
    store: db.instances,
    tellOwner: async (to, message) => { mailed.push({ to, subject: message.subject }); },
    tellOperators: async (message) => { operators.push(message.subject); },
    afterMs: GRACE,
    log: () => undefined,
  });
  wireInstancePresence(io, presence, async (instanceId, token) =>
    token === `good-${instanceId}` ? (await db.instances.getInstances()).find((entry) => entry.id === instanceId) : undefined);
  await new Promise<void>((resolve) => server.listen(onPort, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  await presence.start();
}

async function stopRoot(): Promise<void> {
  presence.stop();
  io.disconnectSockets(true);
  await io.close();
}

function instanceDialing(instance: InstanceRecord, token = `good-${instance.id}`) {
  const pushed: string[] = [];
  const client = new RootPresence({
    rootUrl: `http://127.0.0.1:${port}`,
    instanceId: instance.id,
    ownerId: instance.ownerId,
    token: async () => token,
    tell: async (_owner, message) => { pushed.push(message.title); },
    afterMs: GRACE,
    retryMs: 50,
    log: () => undefined,
  });
  clients.push(client);
  client.start();
  return { client, pushed };
}

const watchOf = async (id: string) => db.instances.getWatch(id);

beforeEach(async () => {
  db = await testDatabase();
  mailed = [];
  operators = [];
  await db.instances.saveInstance(own);
  await db.instances.saveInstance(pooled);
  await startRoot();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await stopRoot();
});

describe('an instance holding a connection to root', () => {
  it('is present while connected, and root tells its owner once when it has been gone the whole grace, and once when it is back', async () => {
    const first = instanceDialing(own);
    await until(() => presence.connected(own.id));
    await until(async () => (await watchOf(own.id))?.reach?.reachable);
    expect((await watchOf(own.id))?.presence).toBe(true);
    expect((await watchOf(own.id))?.reach?.reachable).toBe(true);
    expect(first.client.view().reachable).toBe(true);

    const stoppedAt = Date.now();
    first.client.stop();
    await until(async () => (await watchOf(own.id))?.reach?.reachable === false);
    await until(() => mailed.length === 1);
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(GRACE);
    expect(mailed[0]).toEqual({ to: 'person', subject: 'Your instance own (inst-own) has not answered for 1 minutes' });
    expect((await watchOf(own.id))?.reach?.toldDown).toBe(true);
    expect(operators).toEqual([]);

    instanceDialing(own);
    await until(() => mailed.length === 2);
    expect(mailed[1]).toEqual({ to: 'person', subject: 'Your instance own (inst-own) answers again' });
    await new Promise((resolve) => setTimeout(resolve, GRACE * 2));
    expect(mailed).toHaveLength(2);
  });

  it('stays present while any of its connections is open, as when an upgrade\'s new pod connects before the old one drains', async () => {
    const old = instanceDialing(own);
    await until(() => presence.connected(own.id));
    instanceDialing(own);
    await until(() => io.of('/instances').sockets.size === 2);
    old.client.stop();
    await until(() => io.of('/instances').sockets.size === 1);
    await new Promise((resolve) => setTimeout(resolve, GRACE * 2));
    expect(presence.connected(own.id)).toBe(true);
    expect((await watchOf(own.id))?.reach?.reachable).toBe(true);
    expect(mailed).toEqual([]);
  });

  it('tells a pool instance\'s operators too, and never an owner who switched it off', async () => {
    await db.instances.saveNotifyWhenUnreachable(own, false);
    const a = instanceDialing(own);
    const b = instanceDialing(pooled);
    await until(() => presence.connected(own.id) && presence.connected(pooled.id));
    a.client.stop();
    b.client.stop();
    await until(() => operators.length === 1);
    await new Promise((resolve) => setTimeout(resolve, GRACE));
    expect(mailed.map((told) => told.to)).toEqual(['trier']);
    expect(operators[0]).toMatch(/^An instance pooled \(inst-pool\) has not answered/);
  });

  it('refuses a connection with a wrong token, and the instance says root is down once the grace is over', async () => {
    const refused = instanceDialing(own, 'wrong');
    await until(() => refused.pushed.length === 1);
    expect(refused.pushed).toEqual(['Koala\'s root is not answering']);
    expect(refused.client.view().down).toBe(true);
    expect(presence.connected(own.id)).toBe(false);
    expect(await watchOf(own.id)).toBeUndefined();
  });

  it('never watches an instance that has not connected since a check-in from an older release', async () => {
    await db.instances.savePresence(own, false);
    await stopRoot();
    await startRoot();
    await new Promise((resolve) => setTimeout(resolve, GRACE * 2));
    expect(mailed).toEqual([]);
  });

  it('gives a watched instance the whole grace again when root starts, and tells its owner if it does not come back', async () => {
    await db.instances.savePresence(own, true);
    await db.instances.saveReach(own, { reachable: true, lastSeenAt: new Date(Date.now() - 3_600_000).toISOString() });
    await stopRoot();
    await startRoot();
    expect((await watchOf(own.id))?.reach?.reachable).toBe(false);
    expect(mailed).toEqual([]);
    await until(() => mailed.length === 1);
    expect(mailed[0]!.subject).toMatch(/^Your instance own \(inst-own\) has not answered/);
  });

  it('notices root going away and coming back on its own, and tells its owner each once', async () => {
    const { client, pushed } = instanceDialing(own);
    await until(() => presence.connected(own.id));
    const rootPort = port;
    await stopRoot();
    await until(() => pushed.length === 1);
    expect(pushed).toEqual(['Koala\'s root is not answering']);
    expect(client.view()).toMatchObject({ reachable: false, down: true });
    await startRoot(rootPort);
    await until(() => pushed.length === 2);
    expect(pushed[1]).toBe('Koala\'s root answers again');
    expect(client.view()).toMatchObject({ reachable: true, down: false });
    await until(() => presence.connected(own.id));
  });
});
