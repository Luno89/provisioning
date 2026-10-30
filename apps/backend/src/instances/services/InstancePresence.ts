import type { InstancesStore } from '../store.js';
import type { InstanceRecord } from '../lib/instances.js';
import {
  graceLeftMs, instanceReachMail, nextReach, reachAtStart, tellsOperator, tellsOwner, watched, type InstanceWatchRecord, type Reach, type Tell,
} from '../lib/instance-watch.js';

export interface InstancePresenceDeps {
  store: Pick<InstancesStore, 'getInstances' | 'getWatches' | 'getWatch' | 'saveReach' | 'savePresence'>;
  tellOwner: (ownerId: string, message: { subject: string; text: string }) => Promise<void>;
  tellOperators: (message: { subject: string; text: string }) => Promise<void>;
  afterMs: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export class InstancePresence {
  private readonly held = new Map<string, Set<string>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly turns = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly deps: InstancePresenceDeps) {}

  async start(): Promise<void> {
    const now = this.now();
    const [instances, watches] = await Promise.all([this.deps.store.getInstances(), this.deps.store.getWatches()]);
    const watchOf = new Map(watches.map((watch) => [watch.instanceId, watch]));
    for (const instance of instances) {
      const watch = watchOf.get(instance.id);
      if (!watched(instance, watch) || this.present(instance.id)) continue;
      await this.inTurn(instance.id, async () => {
        if (this.present(instance.id)) return;
        const reach = reachAtStart(watch?.reach, now);
        if (reach !== watch?.reach) await this.deps.store.saveReach(instance, reach);
        this.schedule(instance.id, reach);
      });
    }
  }

  connected(instanceId: string): boolean {
    return this.present(instanceId);
  }

  arrived(instance: InstanceRecord, connection: string): Promise<void> {
    const held = this.held.get(instance.id) ?? new Set<string>();
    held.add(connection);
    this.held.set(instance.id, held);
    this.clear(instance.id);
    return this.inTurn(instance.id, async () => {
      const watch = await this.deps.store.getWatch(instance.id);
      if (watch?.presence !== true) await this.deps.store.savePresence(instance, true);
      const { reach, tell } = nextReach(watch?.reach, true, this.now(), this.deps.afterMs);
      await this.deps.store.saveReach(instance, reach);
      if (tell && !this.stopped) await this.tell(instance, watch, tell, reach);
    });
  }

  left(instanceId: string, connection: string): Promise<void> {
    const held = this.held.get(instanceId);
    held?.delete(connection);
    if (held?.size) return Promise.resolve();
    this.held.delete(instanceId);
    return this.inTurn(instanceId, async () => {
      if (this.present(instanceId)) return;
      const found = await this.find(instanceId);
      if (!found) return;
      const { reach } = nextReach(found.watch?.reach, false, this.now(), this.deps.afterMs);
      await this.deps.store.saveReach(found.instance, reach);
      this.schedule(instanceId, reach);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private judge(instanceId: string): Promise<void> {
    this.timers.delete(instanceId);
    return this.inTurn(instanceId, async () => {
      if (this.stopped || this.present(instanceId)) return;
      const found = await this.find(instanceId);
      if (!found) return;
      const { reach, tell } = nextReach(found.watch?.reach, false, this.now(), this.deps.afterMs);
      await this.deps.store.saveReach(found.instance, reach);
      if (tell) await this.tell(found.instance, found.watch, tell, reach);
      else this.schedule(instanceId, reach);
    });
  }

  private async find(instanceId: string): Promise<{ instance: InstanceRecord; watch: InstanceWatchRecord | undefined } | undefined> {
    const instance = (await this.deps.store.getInstances()).find((entry) => entry.id === instanceId);
    if (!instance) return undefined;
    const watch = await this.deps.store.getWatch(instanceId);
    return watched(instance, watch) ? { instance, watch } : undefined;
  }

  private schedule(instanceId: string, reach: Reach): void {
    this.clear(instanceId);
    if (this.stopped) return;
    const wait = graceLeftMs(reach, this.now(), this.deps.afterMs);
    if (wait === undefined) return;
    const timer = setTimeout(() => { this.judge(instanceId).catch((err: Error) => this.log(`[instance-presence] ${instanceId}: ${err.message}`)); }, wait);
    timer.unref();
    this.timers.set(instanceId, timer);
  }

  private clear(instanceId: string): void {
    const timer = this.timers.get(instanceId);
    if (timer) clearTimeout(timer);
    this.timers.delete(instanceId);
  }

  private async tell(instance: InstanceRecord, watch: InstanceWatchRecord | undefined, tell: Tell, reach: Reach): Promise<void> {
    const now = this.now();
    if (tellsOwner(instance, watch)) {
      await this.deps.tellOwner(instance.ownerId, instanceReachMail(tell, instance, reach, now))
        .catch((err: Error) => this.log(`[instance-presence] could not tell the owner of ${instance.id}: ${err.message}`));
    }
    if (tellsOperator(instance)) {
      await this.deps.tellOperators(instanceReachMail(tell, instance, reach, now, true))
        .catch((err: Error) => this.log(`[instance-presence] could not tell the operator about ${instance.id}: ${err.message}`));
    }
  }

  private inTurn(instanceId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.turns.get(instanceId) ?? Promise.resolve()).then(work, work);
    const settled = next.catch((err: Error) => this.log(`[instance-presence] ${instanceId}: ${err.message}`));
    this.turns.set(instanceId, settled);
    void settled.then(() => { if (this.turns.get(instanceId) === settled) this.turns.delete(instanceId); });
    return settled;
  }

  private present(instanceId: string): boolean {
    return (this.held.get(instanceId)?.size ?? 0) > 0;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}
