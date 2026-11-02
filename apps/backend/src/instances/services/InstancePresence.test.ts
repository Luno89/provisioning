import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { InstanceRecord } from '../lib/instances.js';
import { InstancePresence, type InstancePresenceDeps } from './InstancePresence.js';

const GRACE = 300_000;
const START = new Date('2026-11-02T12:00:00.000Z');
const own: InstanceRecord = { id: 'inst-own', ownerId: 'person', url: 'https://own.example', createdAt: '', updatedAt: '', status: 'ready', name: 'own' };
const pooled: InstanceRecord = { ...own, id: 'inst-pool', ownerId: 'trier', name: 'pooled', pool: { ports: { backend: 1, edge: 2, registry: 3 }, startedAt: '', trialEndsAt: '' } };

let db: Database;
let mailed: Array<{ to: string; subject: string }>;
let operators: string[];
let logged: string[];
let presence: InstancePresence;

const make = (over: Partial<InstancePresenceDeps> = {}): InstancePresence => new InstancePresence({
  store: db.instances,
  tellOwner: async (to, message) => { mailed.push({ to, subject: message.subject }); },
  tellOperators: async (message) => { operators.push(message.subject); },
  afterMs: GRACE,
  log: (message) => logged.push(message),
  ...over,
});

const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  db = memoryDatabase();
  mailed = [];
  operators = [];
  logged = [];
  await db.instances.saveInstance(own);
  await db.instances.saveInstance(pooled);
  presence = make();
});

afterEach(() => {
  presence.stop();
  vi.useRealTimers();
});

describe('an instance holding a connection to root', () => {
  it('is present while connected, and root tells its owner once when it has been gone the whole grace, and once when it is back', async () => {
    await presence.arrived(own, 'a');
    expect(presence.connected(own.id)).toBe(true);
    expect(await db.instances.getWatch(own.id)).toMatchObject({ presence: true, reach: { reachable: true } });

    await presence.left(own.id, 'a');
    expect(presence.connected(own.id)).toBe(false);
    expect((await db.instances.getWatch(own.id))?.reach?.reachable).toBe(false);
    await pass(GRACE - 1000);
    expect(mailed).toEqual([]);
    await pass(2000);
    expect(mailed).toEqual([{ to: 'person', subject: 'Your instance own (inst-own) has not answered for 5 minutes' }]);
    expect((await db.instances.getWatch(own.id))?.reach?.toldDown).toBe(true);
    expect(operators).toEqual([]);

    await pass(GRACE * 3);
    expect(mailed).toHaveLength(1);

    await presence.arrived(own, 'b');
    expect(mailed[1]).toEqual({ to: 'person', subject: 'Your instance own (inst-own) answers again' });
    expect((await db.instances.getWatch(own.id))?.reach).toMatchObject({ reachable: true });
  });

  it('stays present while any of its connections is open, as when an upgrade\'s new pod connects before the old one drains', async () => {
    await presence.arrived(own, 'old');
    await presence.arrived(own, 'new');
    await presence.left(own.id, 'old');
    await pass(GRACE * 2);
    expect(presence.connected(own.id)).toBe(true);
    expect((await db.instances.getWatch(own.id))?.reach?.reachable).toBe(true);
    expect(mailed).toEqual([]);
  });

  it('keeps an instance present when a connection it never heard of is reported gone', async () => {
    await presence.left('inst-unknown', 'a');
    await presence.arrived(own, 'a');
    await presence.left(own.id, 'never-opened');
    expect(presence.connected(own.id)).toBe(true);
    expect(await db.instances.getWatch('inst-unknown')).toBeUndefined();
  });

  it('is not judged while it reconnects before the grace is over', async () => {
    await presence.arrived(own, 'a');
    await presence.left(own.id, 'a');
    await pass(GRACE / 2);
    await presence.arrived(own, 'b');
    await pass(GRACE * 2);
    expect(mailed).toEqual([]);
    expect((await db.instances.getWatch(own.id))?.reach?.reachable).toBe(true);
  });

  it('tells a pool instance\'s operators too, and never an owner who switched it off', async () => {
    await db.instances.saveNotifyWhenUnreachable(own, false);
    await presence.arrived(own, 'a');
    await presence.arrived(pooled, 'b');
    await presence.left(own.id, 'a');
    await presence.left(pooled.id, 'b');
    await pass(GRACE + 1000);
    expect(mailed.map((told) => told.to)).toEqual(['trier']);
    expect(operators).toHaveLength(1);
    expect(operators[0]).toMatch(/^An instance pooled \(inst-pool\) has not answered/);
  });

  it('says so, and goes on, when it cannot tell the owner or the operators', async () => {
    presence.stop();
    presence = make({
      tellOwner: async () => { throw new Error('mail is off'); },
      tellOperators: async () => { throw new Error('no operators'); },
    });
    await presence.arrived(pooled, 'a');
    await presence.left(pooled.id, 'a');
    await pass(GRACE + 1000);
    expect(logged).toEqual([
      '[instance-presence] could not tell the owner of inst-pool: mail is off',
      '[instance-presence] could not tell the operator about inst-pool: no operators',
    ]);
    expect((await db.instances.getWatch(pooled.id))?.reach?.toldDown).toBe(true);
  });

  it('stops watching an instance that is gone or no longer in service when the grace is up', async () => {
    await presence.arrived(own, 'a');
    await presence.left(own.id, 'a');
    await db.instances.deleteInstance(own.id);
    await pass(GRACE + 1000);
    expect(mailed).toEqual([]);

    await presence.arrived(pooled, 'a');
    await presence.left(pooled.id, 'a');
    await db.instances.saveInstance({ ...pooled, status: 'paused' });
    await pass(GRACE + 1000);
    expect(operators).toEqual([]);
  });

  it('tells nobody and sets no timers after it is stopped', async () => {
    await presence.arrived(own, 'a');
    await presence.left(own.id, 'a');
    presence.stop();
    await pass(GRACE * 2);
    expect(mailed).toEqual([]);
    await presence.arrived(own, 'b');
    await presence.left(own.id, 'b');
    await pass(GRACE * 2);
    expect(mailed).toEqual([]);
  });

  it('does not tell that an instance is back when root is being stopped', async () => {
    await presence.arrived(own, 'a');
    await presence.left(own.id, 'a');
    await pass(GRACE + 1000);
    expect(mailed).toHaveLength(1);
    const arriving = presence.arrived(own, 'b');
    presence.stop();
    await arriving;
    expect(mailed).toHaveLength(1);
  });

  it('logs a store failure on the instance\'s turn and keeps taking later ones', async () => {
    const failing = make({ store: { ...db.instances, getWatch: async () => { throw new Error('the database is gone'); }, getInstances: db.instances.getInstances.bind(db.instances), getWatches: db.instances.getWatches.bind(db.instances), saveReach: db.instances.saveReach.bind(db.instances), savePresence: db.instances.savePresence.bind(db.instances) } });
    await failing.arrived(own, 'a');
    expect(logged).toEqual(['[instance-presence] inst-own: the database is gone']);
    expect(failing.connected(own.id)).toBe(true);
    failing.stop();
  });

  it('logs to the console when it is given no logger', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const quiet = new InstancePresence({
        store: { ...db.instances, getWatch: async () => { throw new Error('boom'); } },
        tellOwner: async () => undefined,
        tellOperators: async () => undefined,
        afterMs: GRACE,
      });
      await quiet.arrived(own, 'a');
      expect(warned).toHaveBeenCalledWith('[instance-presence] inst-own: boom');
      quiet.stop();
    } finally {
      warned.mockRestore();
    }
  });
});

describe('root starting up', () => {
  it('never watches an instance that has not connected since a check-in from an older release', async () => {
    await db.instances.savePresence(own, false);
    await presence.start();
    await pass(GRACE * 2);
    expect(mailed).toEqual([]);
    expect(await db.instances.getWatch(own.id)).toMatchObject({ presence: false });
  });

  it('gives a watched instance the whole grace again, and tells its owner if it does not come back', async () => {
    await db.instances.savePresence(own, true);
    await db.instances.saveReach(own, { reachable: true, lastSeenAt: new Date(START.getTime() - 3_600_000).toISOString() });
    await presence.start();
    expect((await db.instances.getWatch(own.id))?.reach).toMatchObject({ reachable: false, unreachableSince: START.toISOString() });
    expect(mailed).toEqual([]);
    await pass(GRACE + 1000);
    expect(mailed).toHaveLength(1);
    expect(mailed[0]!.subject).toMatch(/^Your instance own \(inst-own\) has not answered/);
  });

  it('leaves an instance that is already connected, or already told about, as it is', async () => {
    await db.instances.savePresence(own, true);
    await db.instances.savePresence(pooled, true);
    await db.instances.saveReach(pooled, { reachable: false, toldDown: true, unreachableSince: '2026-11-01T00:00:00.000Z' });
    await presence.arrived(own, 'a');
    await presence.start();
    expect((await db.instances.getWatch(own.id))?.reach?.reachable).toBe(true);
    expect((await db.instances.getWatch(pooled.id))?.reach).toEqual({ reachable: false, toldDown: true, unreachableSince: '2026-11-01T00:00:00.000Z' });
    await pass(GRACE * 2);
    expect(mailed).toEqual([]);
  });
});
