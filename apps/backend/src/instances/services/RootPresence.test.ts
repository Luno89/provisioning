import { EventEmitter } from 'node:events';
import type { ManagerOptions, Socket, SocketOptions } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootPresence, presenceUrl, type RootPresenceDeps } from './RootPresence.js';
import { DependencyStates } from '../../platform/services/DependencyStates.js';
import { PRESENCE_RENEW, PRESENCE_TOKEN } from '../lib/instance-watch.js';

const GRACE = 300_000;
const START = new Date('2026-11-02T12:00:00.000Z');

class FakeSocket extends EventEmitter {
  connected = false;
  active = true;
  connects = 0;
  closed = false;
  private readonly any: Array<(event: string) => void> = [];
  connect(): this {
    this.connects += 1;
    return this;
  }
  onAny(listener: (event: string) => void): this {
    this.any.push(listener);
    return this;
  }
  hear(event: string): void {
    for (const listener of this.any) listener(event);
    this.emit(event);
  }
  dropped = 0;
  disconnect(): this {
    this.dropped += 1;
    this.active = false;
    return this;
  }
  close(): this {
    this.closed = true;
    this.connected = false;
    return this;
  }
  arrive(): void {
    this.connected = true;
    this.emit('connect');
  }
  leave(reason = 'transport close'): void {
    this.connected = false;
    this.emit('disconnect', reason);
  }
}

let socket: FakeSocket;
let dialed: Array<{ url: string; options: Partial<ManagerOptions & SocketOptions> }>;
let pushed: Array<{ ownerId: string; title: string; path: string; tag: string }>;
let said: string[];
let tokens: () => Promise<string>;

const rootPresence = (over: { [K in keyof RootPresenceDeps]?: RootPresenceDeps[K] | undefined } = {}): RootPresence => new RootPresence({
  rootUrl: 'https://app.example.com/',
  instanceId: 'inst-1',
  ownerId: 'owner-1',
  token: () => tokens(),
  tell: async (ownerId, message) => { pushed.push({ ownerId, title: message.title, path: message.path, tag: message.tag }); },
  afterMs: GRACE,
  retryMs: 1000,
  connect: (url, options) => {
    dialed.push({ url, options });
    return socket as unknown as Socket;
  },
  log: (message) => said.push(message),
  ...(over as Partial<RootPresenceDeps>),
});

const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  socket = new FakeSocket();
  dialed = [];
  pushed = [];
  said = [];
  tokens = async () => 'service-token';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an instance keeping a connection to root', () => {
  it('dials root\'s presence namespace over a websocket, presenting a fresh service token every attempt', async () => {
    const presence = rootPresence();
    presence.start();
    expect(dialed).toHaveLength(1);
    expect(dialed[0]!.url).toBe('https://app.example.com/instances');
    expect(dialed[0]!.options).toMatchObject({ transports: ['websocket'], reconnectionDelayMax: 1000 });
    const sent = vi.fn();
    (dialed[0]!.options.auth as (send: (data: object) => void) => void)(sent);
    await pass(0);
    expect(sent).toHaveBeenCalledWith({ instanceId: 'inst-1', token: 'service-token' });
    presence.stop();
  });

  it('answers root asking for a fresh token with a fresh service token over the same connection', async () => {
    const presence = rootPresence();
    const sent: unknown[][] = [];
    (socket as unknown as { emit: (...args: unknown[]) => boolean }).emit = function emitting(this: FakeSocket, ...args: unknown[]) {
      if (args[0] === PRESENCE_TOKEN) sent.push(args);
      return EventEmitter.prototype.emit.apply(this, args as [string, ...unknown[]]);
    };
    presence.start();
    socket.arrive();
    tokens = async () => 'fresh-token';
    socket.hear(PRESENCE_RENEW);
    await pass(0);
    expect(sent).toEqual([[PRESENCE_TOKEN, 'fresh-token']]);
    presence.stop();
  });

  it('drops the attempt rather than present a token it does not have, saying why once, and dials again later', async () => {
    tokens = async () => { throw new Error('no credential yet'); };
    const presence = rootPresence();
    presence.start();
    const sent = vi.fn();
    const auth = dialed[0]!.options.auth as (send: (data: object) => void) => void;
    auth(sent);
    auth(sent);
    await pass(0);
    expect(sent).not.toHaveBeenCalled();
    expect(socket.dropped).toBe(2);
    expect(said).toEqual(['[root-presence] a token for root could not be had: no credential yet']);
    expect(presence.downReason()).toBe('a token for root could not be had: no credential yet');
    await pass(1000);
    expect(socket.connects).toBe(1);
    presence.stop();
  });

  it('dials only once however often it is started', () => {
    const presence = rootPresence();
    presence.start();
    presence.start();
    expect(dialed).toHaveLength(1);
    presence.stop();
  });

  it('is reachable while connected and says so', () => {
    const presence = rootPresence();
    expect(presence.view()).toEqual({ rootUrl: 'https://app.example.com/', reachable: true, down: false });
    expect(presence.connected()).toBe(false);
    presence.start();
    socket.arrive();
    expect(presence.connected()).toBe(true);
    expect(presence.view()).toMatchObject({ reachable: true, down: false, lastSeenAt: START.toISOString() });
    presence.stop();
    expect(presence.connected()).toBe(false);
    expect(socket.closed).toBe(true);
  });

  it('tells its owner once that root is not answering after the whole grace, and once when it answers again', async () => {
    const presence = rootPresence();
    presence.start();
    socket.arrive();
    socket.leave();
    expect(presence.view()).toMatchObject({ reachable: false, down: false });
    await pass(GRACE - 1000);
    expect(pushed).toEqual([]);
    await pass(2000);
    expect(pushed).toEqual([{ ownerId: 'owner-1', title: 'Koala\'s root is not answering', path: '/#/infrastructure', tag: 'koala-root' }]);
    expect(presence.view()).toMatchObject({ reachable: false, down: true });
    await pass(GRACE * 2);
    expect(pushed).toHaveLength(1);
    socket.arrive();
    await pass(0);
    expect(pushed.map((entry) => entry.title)).toEqual(['Koala\'s root is not answering', 'Koala\'s root answers again']);
    expect(presence.view()).toMatchObject({ reachable: true, down: false });
    presence.stop();
  });

  it('makes root\'s dependency state down only once the grace is up, since it was last connected, and answering when it connects', async () => {
    const dependency = new DependencyStates({ process: 'backend', described: ['root'], where: { root: 'https://app.example.com/' }, log: () => undefined });
    const presence = rootPresence({ dependency });
    presence.start();
    socket.arrive();
    socket.leave();
    const left = new Date(Date.now()).toISOString();
    await pass(GRACE - 1000);
    expect(dependency.down()).toEqual([]);
    await pass(2000);
    expect(dependency.down()).toEqual([{ dependency: 'root', name: 'Koala\'s root', since: left, reason: 'this instance\'s connection to it is closed', process: 'backend', where: 'https://app.example.com/' }]);
    socket.arrive();
    await pass(0);
    expect(dependency.down()).toEqual([]);
    presence.stop();
    dependency.stop();
  });

  it('counts the grace from the start when it never reaches root at all', async () => {
    const presence = rootPresence();
    presence.start();
    await pass(GRACE + 1000);
    expect(pushed.map((entry) => entry.title)).toEqual(['Koala\'s root is not answering']);
    presence.stop();
  });

  it('does not call root down when it is connected by the time the grace is up', async () => {
    const presence = rootPresence();
    presence.start();
    await pass(GRACE - 1000);
    socket.arrive();
    await pass(GRACE);
    expect(pushed).toEqual([]);
    presence.stop();
  });

  it('asks again by itself after root closes the connection, and says so when root refuses it', async () => {
    const presence = rootPresence();
    presence.start();
    socket.arrive();
    socket.leave('io server disconnect');
    expect(socket.connects).toBe(0);
    await pass(1000);
    expect(socket.connects).toBe(1);
    socket.active = false;
    socket.emit('connect_error', new Error('Unauthorized'));
    socket.emit('connect_error', new Error('Unauthorized'));
    expect(said).toEqual(['[root-presence] root refused this instance\'s connection: Unauthorized']);
    await pass(1000);
    expect(socket.connects).toBe(2);
    presence.stop();
  });

  it('leaves the retrying to the socket while it is still trying itself, and does not retry a connection that came back', async () => {
    const presence = rootPresence();
    presence.start();
    socket.active = true;
    socket.emit('connect_error', new Error('websocket error'));
    await pass(5000);
    expect(socket.connects).toBe(0);
    socket.active = false;
    socket.emit('connect_error', new Error('Unauthorized'));
    socket.arrive();
    await pass(1000);
    expect(socket.connects).toBe(0);
    presence.stop();
  });

  it('does not retry once stopped', async () => {
    const presence = rootPresence();
    presence.start();
    socket.leave('io server disconnect');
    presence.stop();
    await pass(5000);
    expect(socket.connects).toBe(0);
  });

  it('says so when it cannot tell its owner', async () => {
    const presence = rootPresence({ tell: async () => { throw new Error('push service is down'); } });
    presence.start();
    await pass(GRACE + 1000);
    expect(said).toEqual(['[root-presence] could not tell the owner: push service is down']);
    presence.stop();
  });

  it('retries every five seconds, and logs to the console, when given neither', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const presence = rootPresence({ retryMs: undefined, log: undefined });
      presence.start();
      expect(dialed[0]!.options.reconnectionDelayMax).toBe(5000);
      socket.active = false;
      socket.emit('connect_error', new Error('Unauthorized'));
      expect(warned).toHaveBeenCalledWith('[root-presence] root refused this instance\'s connection: Unauthorized');
      await pass(5000);
      expect(socket.connects).toBe(1);
      presence.stop();
    } finally {
      warned.mockRestore();
    }
  });

  it('reads the real clock when it is not given one', () => {
    const presence = rootPresence({ now: undefined });
    presence.start();
    socket.arrive();
    expect(presence.view().lastSeenAt).toBe(START.toISOString());
    presence.stop();
  });
});

describe('the address of root\'s presence namespace', () => {
  it('is root\'s address without its trailing slashes, then the namespace', () => {
    expect(presenceUrl('https://app.example.com///')).toBe('https://app.example.com/instances');
  });
});

describe('what root tells an instance over the same connection', () => {
  it('hands each event to the instance\'s handler, including one it registered after dialling, and runs its connect handler on every connect', async () => {
    const heard: Record<string, () => void> = {};
    const said: string[] = [];
    const presence = rootPresence({ heard });
    presence.start();
    heard['machines:changed'] = () => said.push('changed');
    heard.connect = () => said.push('connected');
    socket.arrive();
    socket.hear('machines:changed');
    socket.hear('something else');
    socket.leave();
    socket.arrive();
    expect(said).toEqual(['connected', 'changed', 'connected']);
  });
});
