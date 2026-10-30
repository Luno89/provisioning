import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { PRESENCE_NAMESPACE, PRESENCE_RETRY_MS, graceLeftMs, isDown, nextReach, rootReachPush, type Reach } from '../lib/instance-watch.js';

export interface RootReachView {
  rootUrl: string;
  reachable: boolean;
  down: boolean;
  unreachableSince?: string | undefined;
  lastSeenAt?: string | undefined;
}

export type PresenceConnect = (url: string, options: Partial<ManagerOptions & SocketOptions>) => Socket;

export interface RootPresenceDeps {
  rootUrl: string;
  instanceId: string;
  ownerId: string;
  token: () => Promise<string>;
  tell: (ownerId: string, message: { title: string; body: string; path: string; tag: string }) => Promise<unknown>;
  afterMs: number;
  retryMs?: number | undefined;
  connect?: PresenceConnect | undefined;
  now?: () => Date;
  log?: (message: string) => void;
}

export const presenceUrl = (rootUrl: string): string => `${rootUrl.replace(/\/+$/, '')}${PRESENCE_NAMESPACE}`;

export class RootPresence {
  private reach: Reach | undefined;
  private socket: Socket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private refusal: string | undefined;

  constructor(private readonly deps: RootPresenceDeps) {}

  start(): void {
    if (this.socket) return;
    this.reach = nextReach(undefined, false, this.now(), this.deps.afterMs).reach;
    this.schedule();
    const socket = (this.deps.connect ?? io)(presenceUrl(this.deps.rootUrl), {
      transports: ['websocket'],
      reconnectionDelayMax: this.retryMs(),
      auth: (send) => {
        this.deps.token().then(
          (token) => send({ instanceId: this.deps.instanceId, token }),
          (err: Error) => { this.say(`a token for root could not be had: ${err.message}`); send({ instanceId: this.deps.instanceId, token: '' }); },
        );
      },
    });
    this.socket = socket;
    socket.on('connect', () => this.arrived());
    socket.on('disconnect', (reason) => {
      this.left();
      if (reason === 'io server disconnect') this.again();
    });
    socket.on('connect_error', (err) => {
      if (!socket.active) {
        this.say(`root refused this instance's connection: ${err.message}`);
        this.again();
      }
    });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = undefined;
    this.retry = undefined;
    this.socket?.close();
    this.socket = undefined;
  }

  connected(): boolean {
    return this.socket?.connected === true;
  }

  view(): RootReachView {
    return {
      rootUrl: this.deps.rootUrl,
      reachable: this.reach?.reachable ?? true,
      down: isDown(this.reach),
      ...(this.reach?.unreachableSince ? { unreachableSince: this.reach.unreachableSince } : {}),
      ...(this.reach?.lastSeenAt ? { lastSeenAt: this.reach.lastSeenAt } : {}),
    };
  }

  private arrived(): void {
    this.refusal = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const { reach, tell } = nextReach(this.reach, true, this.now(), this.deps.afterMs);
    this.reach = reach;
    if (tell) this.tellOwner(tell);
  }

  private left(): void {
    this.reach = nextReach(this.reach, false, this.now(), this.deps.afterMs).reach;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const wait = graceLeftMs(this.reach, this.now(), this.deps.afterMs);
    if (wait === undefined) return;
    this.timer = setTimeout(() => this.judge(), wait);
    this.timer.unref();
  }

  private judge(): void {
    this.timer = undefined;
    if (this.connected()) return;
    const { reach, tell } = nextReach(this.reach, false, this.now(), this.deps.afterMs);
    this.reach = reach;
    if (tell) this.tellOwner(tell);
    else this.schedule();
  }

  private again(): void {
    if (this.retry || !this.socket) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.socket && !this.socket.connected) this.socket.connect();
    }, this.retryMs());
    this.retry.unref();
  }

  private tellOwner(tell: 'down' | 'back'): void {
    const message = rootReachPush(tell, this.deps.rootUrl, this.reach!, this.now());
    this.deps.tell(this.deps.ownerId, { ...message, path: '/#/infrastructure', tag: 'koala-root' })
      .catch((err: Error) => this.say(`could not tell the owner: ${err.message}`));
  }

  private say(message: string): void {
    if (this.refusal === message) return;
    this.refusal = message;
    (this.deps.log ?? console.warn)(`[root-presence] ${message}`);
  }

  private retryMs(): number {
    return this.deps.retryMs ?? PRESENCE_RETRY_MS;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}
