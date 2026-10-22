import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { HubRole } from '../lib/hub.js';
import type { RelayOp } from '../lib/hub-board.js';

export interface RelayCaller {
  personId: string;
  email: string;
  role: HubRole;
}

export interface RelayCall {
  id: string;
  projectId: string;
  op: RelayOp;
  args: Record<string, unknown>;
  as: RelayCaller;
  upload?: { stream: Readable; type: string; size?: number | undefined } | undefined;
}

export type RelayAnswer =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'stream'; status: number; type: string; name?: string | undefined; size?: number | undefined; stream: Readable };

export class InstanceOffline extends Error {
  constructor(why = 'The owner\'s instance is offline, so this cannot be read until it is back.') {
    super(why);
    this.name = 'InstanceOffline';
  }
}

interface Pending {
  call: RelayCall;
  resolve: (answer: RelayAnswer) => void;
  reject: (err: Error) => void;
}

interface Place {
  pollers: ((call: RelayCall | undefined) => void)[];
  queue: Pending[];
  lastSeen: number;
}

export const OFFLINE_AFTER_MS = 10_000;

export class HubRelay {
  private readonly places = new Map<string, Place>();
  private readonly pending = new Map<string, Pending>();
  private readonly watch: ReturnType<typeof setInterval>;

  constructor(private readonly now: () => number = Date.now, checkEveryMs = 2_000) {
    this.watch = setInterval(() => this.check(), checkEveryMs);
    this.watch.unref?.();
  }

  private place(projectId: string): Place {
    let place = this.places.get(projectId);
    if (!place) { place = { pollers: [], queue: [], lastSeen: 0 }; this.places.set(projectId, place); }
    return place;
  }

  online(projectId: string): boolean {
    const place = this.places.get(projectId);
    return Boolean(place && (place.pollers.length > 0 || this.now() - place.lastSeen < OFFLINE_AFTER_MS));
  }

  call(projectId: string, op: RelayOp, args: Record<string, unknown>, as: RelayCaller, upload?: RelayCall['upload']): Promise<RelayAnswer> {
    if (!this.online(projectId)) return Promise.reject(new InstanceOffline());
    const place = this.place(projectId);
    return new Promise<RelayAnswer>((resolve, reject) => {
      const call: RelayCall = { id: randomBytes(12).toString('hex'), projectId, op, args, as, ...(upload ? { upload } : {}) };
      const entry: Pending = { call, resolve, reject };
      this.pending.set(call.id, entry);
      const poller = place.pollers.shift();
      if (poller) poller(call);
      else place.queue.push(entry);
    });
  }

  take(projectId: string, closed: Promise<void>): Promise<RelayCall | undefined> {
    const place = this.place(projectId);
    place.lastSeen = this.now();
    const queued = place.queue.shift();
    if (queued) return Promise.resolve(queued.call);
    return new Promise<RelayCall | undefined>((resolve) => {
      const poller = (call: RelayCall | undefined) => {
        place.lastSeen = this.now();
        resolve(call);
      };
      place.pollers.push(poller);
      void closed.then(() => {
        const at = place.pollers.indexOf(poller);
        if (at >= 0) {
          place.pollers.splice(at, 1);
          place.lastSeen = this.now();
          resolve(undefined);
        }
      });
    });
  }

  callOf(callId: string): RelayCall | undefined {
    return this.pending.get(callId)?.call;
  }

  answer(callId: string, answer: RelayAnswer): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;
    this.pending.delete(callId);
    entry.resolve(answer);
    return true;
  }

  private check(): void {
    for (const [projectId, place] of this.places) {
      if (this.online(projectId)) continue;
      for (const entry of [...this.pending.values()].filter((candidate) => candidate.call.projectId === projectId)) {
        this.pending.delete(entry.call.id);
        entry.reject(new InstanceOffline('The owner\'s instance went offline before it answered.'));
      }
      place.queue = [];
      if (place.pollers.length === 0) this.places.delete(projectId);
    }
  }

  stop(): void {
    clearInterval(this.watch);
  }
}
