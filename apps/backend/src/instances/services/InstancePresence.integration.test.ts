import http from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { InstanceRecord } from '../lib/instances.js';
import type { Watching } from '../../platform/index.js';
import { InstancePresence } from './InstancePresence.js';
import { RootPresence } from './RootPresence.js';
import { instanceRoom, wireInstancePresence } from '../wiring/instances.js';

const fresh = await emptiedEachTime();

const GRACE = 300;
const own: InstanceRecord = { id: 'inst-own', ownerId: 'person', url: 'https://own.example', createdAt: '', updatedAt: '', status: 'ready', name: 'own' };
const second: InstanceRecord = { ...own, id: 'inst-second', ownerId: 'trier', name: 'second' };

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
let logged: string[];
let mailFails: boolean;
const clients: RootPresence[] = [];

let tellInstance: (instanceId: string, event: string) => void = () => undefined;
let arrivals: string[] = [];
let checked: string[] = [];
let clock = 1_000_000;
const runsOutAt = new Map<string, number>();
let removalsWatched: Watching | undefined;
let removalsHeard: string[] = [];

async function startRoot(onPort = 0): Promise<void> {
  server = http.createServer();
  io = new Server(server, { pingInterval: 10_000, pingTimeout: 10_000 });
  presence = new InstancePresence({
    store: db.instances,
    tellOwner: async (to, message) => {
      if (mailFails) throw new Error('mail is away');
      mailed.push({ to, subject: message.subject });
    },
    afterMs: GRACE,
    log: (message) => { logged.push(message); },
  });
  tellInstance = wireInstancePresence(io, presence, {
    caller: async (instanceId, token) => {
      checked.push(token);
      const instance = (await db.instances.getInstances()).find((entry) => entry.id === instanceId);
      return instance && (token === `good-${instanceId}` || token === `fresh-${instanceId}`) ? { instance, until: runsOutAt.get(token) ?? Number.MAX_SAFE_INTEGER } : undefined;
    },
    arrived: (instance) => { arrivals.push(instance.id); },
    removals: (on) => {
      removalsWatched = db.instances.watchInstanceRemovals((instanceId) => {
        on(instanceId);
        removalsHeard.push(instanceId);
      });
      return removalsWatched;
    },
    now: () => clock,
  });
  await new Promise<void>((resolve) => server.listen(onPort, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  await presence.start();
}

async function stopRoot(): Promise<void> {
  presence.stop();
  await removalsWatched?.close();
  io.disconnectSockets(true);
  await io.close();
}

function instanceDialing(instance: InstanceRecord, token: string | string[] = `good-${instance.id}`, heard: Record<string, () => void> = {}) {
  const pushed: string[] = [];
  const tokens = Array.isArray(token) ? [...token] : [token];
  const client = new RootPresence({
    heard,
    rootUrl: `http://127.0.0.1:${port}`,
    instanceId: instance.id,
    ownerId: instance.ownerId,
    token: async () => (tokens.length > 1 ? tokens.shift()! : tokens[0]!),
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
  db = await fresh();
  mailed = [];
  logged = [];
  mailFails = false;
  arrivals = [];
  checked = [];
  removalsWatched = undefined;
  removalsHeard = [];
  clock = 1_000_000;
  runsOutAt.clear();
  await db.instances.saveInstance(own);
  await db.instances.saveInstance(second);
  await startRoot();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await stopRoot();
});

describe('root telling an instance over its connection', () => {
  it('names the instance to root\'s machines as it arrives, and tells only that instance its machines changed', async () => {
    const said: string[] = [];
    const elsewhere: string[] = [];
    const heard = { connect: () => said.push('connected'), 'machines:changed': () => said.push('changed') };
    const { client } = instanceDialing(own, undefined, heard);
    instanceDialing(second, undefined, { 'machines:changed': () => elsewhere.push('changed') });
    await until(() => (client.connected() && arrivals.length === 2 ? true : undefined));
    expect(arrivals.sort()).toEqual([own.id, second.id].sort());
    tellInstance(own.id, 'machines:changed');
    await until(() => (said.includes('changed') ? true : undefined));
    expect(said).toEqual(['connected', 'changed']);
    expect(elsewhere).toEqual([]);
  });
});

describe('the token an instance holds its connection with', () => {
  it('asks the instance for a fresh token once the one it connected with has run out, and tells it what root had to say on the fresh one', async () => {
    runsOutAt.set(`good-${own.id}`, clock + 1000);
    const said: string[] = [];
    const { client } = instanceDialing(own, [`good-${own.id}`, `fresh-${own.id}`], { 'machines:changed': () => said.push('changed') });
    await until(() => client.connected());
    tellInstance(own.id, 'machines:changed');
    await until(() => (said.length === 1 ? true : undefined));
    expect(checked).toEqual([`good-${own.id}`]);
    clock += 2000;
    tellInstance(own.id, 'machines:changed');
    await until(() => (said.length === 2 ? true : undefined));
    expect(checked).toEqual([`good-${own.id}`, `fresh-${own.id}`]);
    expect(client.connected()).toBe(true);
  });

  it('cuts the connection of an instance whose fresh token root refuses, and tells it nothing more', async () => {
    runsOutAt.set(`good-${own.id}`, clock + 1000);
    const said: string[] = [];
    const left: string[] = [];
    const { client } = instanceDialing(own, [`good-${own.id}`, 'wrong'], { 'machines:changed': () => said.push('changed') });
    const socket = await until(() => [...io.of('/instances').sockets.values()][0]);
    socket.on('disconnect', () => left.push('cut'));
    clock += 2000;
    tellInstance(own.id, 'machines:changed');
    await until(() => (left.length === 1 ? true : undefined));
    expect(said).toEqual([]);
    expect(client.connected()).toBe(false);
  });

  it('cuts an instance\'s connection the moment the instance is removed, and leaves the others connected', async () => {
    const removed = instanceDialing(own);
    const kept = instanceDialing(second);
    await until(() => presence.connected(own.id) && presence.connected(second.id));
    await db.instances.deleteInstance(own.id);
    const holds = () => (io.of('/instances').adapter.rooms.get(instanceRoom(own.id))?.size ?? 0) > 0;
    const ending = await until(() => {
      if (!removed.client.connected()) return 'cut';
      if (removalsWatched === undefined) return 'never cut: root does not follow removals, so no close can come';
      if (removalsHeard.includes(own.id) && holds()) return 'never cut: root heard the removal and still holds the connection, so no close can come';
      return undefined;
    });
    expect(ending).toBe('cut');
    expect(presence.connected(own.id)).toBe(false);
    expect(kept.client.connected()).toBe(true);
  });
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

  it('never tells an owner who switched it off', async () => {
    await db.instances.saveNotifyWhenUnreachable(own, false);
    const a = instanceDialing(own);
    const b = instanceDialing(second);
    await until(() => presence.connected(own.id) && presence.connected(second.id));
    a.client.stop();
    b.client.stop();
    await until(() => mailed.length === 1);
    await new Promise((resolve) => setTimeout(resolve, GRACE));
    expect(mailed.map((told) => told.to)).toEqual(['trier']);
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

  it('says in its log, and carries on, when it cannot tell the owner', async () => {
    mailFails = true;
    const { client } = instanceDialing(own);
    await until(() => presence.connected(own.id));
    client.stop();
    await until(() => logged.length === 1);
    expect(logged[0]).toBe('[instance-presence] could not tell the owner of inst-own: mail is away');
    expect(mailed).toEqual([]);
    mailFails = false;
    instanceDialing(own);
    await until(() => presence.connected(own.id));
    await until(() => mailed.length === 1);
    expect(mailed[0]!.subject).toBe('Your instance own (inst-own) answers again');
  });
});
