import type { InstancesStore } from '../store.js';
import type { InstanceRecord } from '../lib/instances.js';
import { PendingProbes } from './PendingProbes.js';
import {
  WATCH_EVERY_MS, instanceReachMail, nextReach, probeUrl, tellsOperator, tellsOwner, watched, type InstanceWatchRecord,
} from '../lib/instance-watch.js';

export interface InstanceWatchDeps {
  store: Pick<InstancesStore, 'getInstances' | 'getWatches' | 'saveReach'>;
  probe: (url: string) => Promise<boolean>;
  tellOwner: (ownerId: string, message: { subject: string; text: string }) => Promise<void>;
  tellOperators: (message: { subject: string; text: string }) => Promise<void>;
  afterMs: number;
  everyMs?: number | undefined;
  now?: () => Date;
  log?: (message: string) => void;
}

export const answersHttp = (fetchImpl: typeof fetch = globalThis.fetch) => async (url: string): Promise<boolean> => {
  try {
    await fetchImpl(url, { redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
};

export class InstanceWatch {
  private readonly probes = new PendingProbes();
  private timer: NodeJS.Timeout | undefined;
  private passing = false;

  constructor(private readonly deps: InstanceWatchDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.pass().catch((err: Error) => this.log(`[instance-watch] ${err.message}`)); }, this.deps.everyMs ?? WATCH_EVERY_MS);
    this.timer.unref();
    this.pass().catch((err: Error) => this.log(`[instance-watch] ${err.message}`));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }

  async pass(): Promise<void> {
    if (this.passing) return;
    this.passing = true;
    try {
      const now = (this.deps.now ?? (() => new Date()))();
      const [instances, watches] = await Promise.all([this.deps.store.getInstances(), this.deps.store.getWatches()]);
      const watchOf = new Map(watches.map((watch) => [watch.instanceId, watch]));
      for (const instance of instances.filter(watched)) {
        const answered = this.probes.answered(instance.id);
        if (answered !== undefined) await this.judge(instance, watchOf.get(instance.id), answered, now);
        this.probes.ask(instance.id, () => this.deps.probe(probeUrl(instance.meshIp!)));
      }
    } finally {
      this.passing = false;
    }
  }

  private async judge(instance: InstanceRecord, watch: InstanceWatchRecord | undefined, answered: boolean, now: Date): Promise<void> {
    const { reach, tell } = nextReach(watch?.reach, answered, now, this.deps.afterMs);
    if (JSON.stringify(reach) !== JSON.stringify(watch?.reach)) await this.deps.store.saveReach(instance, reach);
    if (!tell) return;
    if (tellsOwner(instance, watch)) {
      await this.deps.tellOwner(instance.ownerId, instanceReachMail(tell, instance, reach, now))
        .catch((err: Error) => this.log(`[instance-watch] could not tell the owner of ${instance.id}: ${err.message}`));
    }
    if (tellsOperator(instance)) {
      await this.deps.tellOperators(instanceReachMail(tell, instance, reach, now, true))
        .catch((err: Error) => this.log(`[instance-watch] could not tell the operator about ${instance.id}: ${err.message}`));
    }
  }
}
