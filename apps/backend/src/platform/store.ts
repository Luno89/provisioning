import type { AreaStore } from './lib/collection.js';
import type { Db } from 'mongodb';
import type { MigrationRecord } from './lib/migrations.js';
import type { EndedSession } from './lib/ended-sessions.js';
import { watchWrites, type Watching } from './lib/change-streams.js';
import { attemptsKeptUntil, type LockoutRule, type SignInAttempts } from './lib/http-limits.js';
import { isDependencyId, type DependencyStateRow } from './lib/dependencies.js';
import { closingOf, fenceIdOf, type Closing, type KoalaProcess, type RaisedFence } from './lib/fence.js';

export interface PlatformStore extends AreaStore {
  hasMigration(name: string): Promise<boolean>;
  recordMigration(record: MigrationRecord): Promise<void>;
  endSession(ended: EndedSession): Promise<void>;
  sessionsEndedSince(at: number): Promise<EndedSession[]>;
  watchSessionEnds(on: (ended: EndedSession) => void): Watching;
  attemptsOf(key: string): Promise<SignInAttempts | undefined>;
  countFailure(key: string, now: number, rule: LockoutRule): Promise<{ before: SignInAttempts | undefined; after: SignInAttempts }>;
  clearAttempts(key: string): Promise<void>;
  saveDependencyState(row: DependencyStateRow): Promise<void>;
  dependencyStates(): Promise<DependencyStateRow[]>;
  raiseFence(closing: Closing, at: string): Promise<void>;
  fencesRaised(): Promise<RaisedFence[]>;
  watchFences(on: (fence: RaisedFence) => void): Watching;
  ackFence(closing: Closing, process: string, at: string): Promise<void>;
  fenceAcks(closing: Closing): Promise<string[]>;
  watchFenceAcks(on: (ack: { closing: Closing; process: string }) => void): Watching;
  confirmFence(closing: Closing): Promise<void>;
  endFence(closing: Closing, liveWith: readonly string[]): Promise<void>;
  dropFence(closing: Closing): Promise<void>;
  beatProcess(process: KoalaProcess, at: string): Promise<void>;
  forgetProcess(id: string): Promise<void>;
  processesSeenSince(at: string): Promise<KoalaProcess[]>;
  watchProcesses(on: () => void): Watching;
}

const PROCESSES: readonly string[] = ['backend', 'worker-host', 'worker-cluster', 'worker-engine'];

const raisedFenceFrom = (doc: Record<string, unknown>): RaisedFence => ({
  closing: { kind: doc.kind === 'project' ? 'project' : 'owner', id: String(doc.id) },
  at: String(doc.at),
  confirmed: doc.confirmed === true,
  ...(Array.isArray(doc.endedWith) ? { endedWith: doc.endedWith.map(String) } : {}),
});

export function dependencyStateFrom(doc: Record<string, unknown>): DependencyStateRow | undefined {
  const { process, dependency, state, since, reason, at } = doc;
  if (typeof process !== 'string' || !PROCESSES.includes(process) || !isDependencyId(dependency)) return undefined;
  if ((state !== 'answering' && state !== 'down') || typeof at !== 'string') return undefined;
  return {
    process: process as DependencyStateRow['process'],
    dependency,
    state,
    ...(typeof since === 'string' ? { since } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
    at,
  };
}

export class MongoPlatformStore implements PlatformStore {
  constructor(private readonly db: () => Db) {}

  private get endedSessions() {
    return this.db().collection('endedSessions');
  }

  private get dependencyStateRows() {
    return this.db().collection('dependencyStates');
  }

  private get signInAttempts() {
    return this.db().collection('signInAttempts');
  }

  private get fences() {
    return this.db().collection('fences');
  }

  private get fenceAckRows() {
    return this.db().collection('fenceAcks');
  }

  private get processes() {
    return this.db().collection('koalaProcesses');
  }

  async ensureIndexes(): Promise<void> {
    await this.endedSessions.createIndex({ until: 1 }, { expireAfterSeconds: 0 });
    await this.endedSessions.createIndex({ at: 1 });
    await this.signInAttempts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.fenceAckRows.createIndex({ fence: 1 });
    await this.processes.createIndex({ beatAt: 1 });
  }

  async raiseFence(closing: Closing, at: string): Promise<void> {
    await this.fences.updateOne({ _id: fenceIdOf(closing) as never }, { $setOnInsert: { kind: closing.kind, id: closing.id, at, confirmed: false } }, { upsert: true });
  }

  async fencesRaised(): Promise<RaisedFence[]> {
    return (await this.fences.find({}).toArray()).map(raisedFenceFrom);
  }

  watchFences(on: (fence: RaisedFence) => void): Watching {
    return watchWrites(() => this.fences, {}, (doc) => on(raisedFenceFrom(doc)));
  }

  async ackFence(closing: Closing, process: string, at: string): Promise<void> {
    await this.fenceAckRows.updateOne({ _id: `${fenceIdOf(closing)}|${process}` as never }, { $set: { fence: fenceIdOf(closing), process, at } }, { upsert: true });
  }

  async fenceAcks(closing: Closing): Promise<string[]> {
    return (await this.fenceAckRows.find({ fence: fenceIdOf(closing) }).toArray()).map((doc) => String(doc.process));
  }

  watchFenceAcks(on: (ack: { closing: Closing; process: string }) => void): Watching {
    return watchWrites(() => this.fenceAckRows, {}, (doc) => {
      const closing = closingOf(String(doc.fence));
      if (closing) on({ closing, process: String(doc.process) });
    });
  }

  async confirmFence(closing: Closing): Promise<void> {
    await this.fences.updateOne({ _id: fenceIdOf(closing) as never }, { $set: { confirmed: true } });
    await this.fenceAckRows.deleteMany({ fence: fenceIdOf(closing) });
  }

  async endFence(closing: Closing, liveWith: readonly string[]): Promise<void> {
    await this.fences.updateOne({ _id: fenceIdOf(closing) as never }, { $set: { endedWith: [...liveWith] } });
  }

  async dropFence(closing: Closing): Promise<void> {
    await this.fenceAckRows.deleteMany({ fence: fenceIdOf(closing) });
    await this.fences.deleteOne({ _id: fenceIdOf(closing) as never });
  }

  async beatProcess(process: KoalaProcess, at: string): Promise<void> {
    await this.processes.updateOne({ _id: process.id as never }, { $set: { name: process.name, beatAt: new Date(at) } }, { upsert: true });
  }

  async forgetProcess(id: string): Promise<void> {
    await this.processes.deleteOne({ _id: id as never });
  }

  async processesSeenSince(at: string): Promise<KoalaProcess[]> {
    return (await this.processes.find({ beatAt: { $gte: new Date(at) } }).toArray()).map((doc) => ({ id: String(doc._id), name: String(doc.name) }));
  }

  watchProcesses(on: () => void): Watching {
    return watchWrites(() => this.processes, {}, () => on());
  }

  async hasMigration(name: string): Promise<boolean> {
    return Boolean(await this.db().collection('migrations').findOne({ _id: name as never }));
  }

  async recordMigration(record: MigrationRecord): Promise<void> {
    const { name, ...rest } = record;
    await this.db().collection('migrations').replaceOne({ _id: name as never }, rest, { upsert: true });
  }

  async endSession(ended: EndedSession): Promise<void> {
    await this.endedSessions.updateOne(
      { _id: ended.id as never },
      { $max: { until: new Date(ended.until) }, $set: { at: new Date(ended.at) } },
      { upsert: true },
    );
  }

  async sessionsEndedSince(at: number): Promise<EndedSession[]> {
    const docs = await this.endedSessions.find({ at: { $gte: new Date(at) }, until: { $gt: new Date() } }).toArray();
    return docs.map((doc) => ({ id: String(doc._id), until: (doc.until as Date).getTime(), at: (doc.at as Date).getTime() }));
  }

  watchSessionEnds(on: (ended: EndedSession) => void): Watching {
    return watchWrites(() => this.endedSessions, {}, (doc) => on({ id: String(doc._id), until: (doc.until as Date).getTime(), at: (doc.at as Date).getTime() }));
  }

  async attemptsOf(key: string): Promise<SignInAttempts | undefined> {
    const doc = await this.signInAttempts.findOne({ _id: key as never });
    return doc ? { failures: (doc.failures as number[]) ?? [] } : undefined;
  }

  async countFailure(key: string, now: number, rule: LockoutRule): Promise<{ before: SignInAttempts | undefined; after: SignInAttempts }> {
    try {
      return await this.failureCounted(key, now, rule);
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      return this.failureCounted(key, now, rule);
    }
  }

  private async failureCounted(key: string, now: number, rule: LockoutRule): Promise<{ before: SignInAttempts | undefined; after: SignInAttempts }> {
    const previous = await this.signInAttempts.findOneAndUpdate(
      { _id: key as never },
      [{
        $set: {
          failures: { $concatArrays: [{ $filter: { input: { $ifNull: ['$failures', []] }, cond: { $gt: ['$$this', now - rule.windowMs] } } }, [now]] },
          expiresAt: new Date(attemptsKeptUntil({ failures: [now] }, rule)),
        },
      }],
      { upsert: true, returnDocument: 'before' },
    );
    const before = previous ? { failures: (previous.failures as number[]) ?? [] } : undefined;
    const after = { failures: [...(before?.failures ?? []).filter((at) => at > now - rule.windowMs), now] };
    return { before, after };
  }

  async clearAttempts(key: string): Promise<void> {
    await this.signInAttempts.deleteOne({ _id: key as never });
  }

  async saveDependencyState(row: DependencyStateRow): Promise<void> {
    const { process, dependency, state, since, reason, at } = row;
    await this.dependencyStateRows.replaceOne(
      { _id: `${process}:${dependency}` as never },
      { process, dependency, state, at, ...(since ? { since } : {}), ...(reason ? { reason } : {}) },
      { upsert: true },
    );
  }

  async dependencyStates(): Promise<DependencyStateRow[]> {
    const docs = await this.dependencyStateRows.find({}).toArray();
    return docs.map((doc) => dependencyStateFrom(doc)).filter((row): row is DependencyStateRow => row !== undefined);
  }
}
