import type { AreaStore } from './lib/collection.js';
import type { Db } from 'mongodb';
import type { MigrationRecord } from './lib/migrations.js';
import type { EndedSession } from './lib/ended-sessions.js';
import { attemptsKeptUntil, type LockoutRule, type SignInAttempts } from './lib/http-limits.js';

export interface PlatformStore extends AreaStore {
  hasMigration(name: string): Promise<boolean>;
  recordMigration(record: MigrationRecord): Promise<void>;
  endSession(ended: EndedSession): Promise<void>;
  sessionsEndedSince(at: number): Promise<EndedSession[]>;
  attemptsOf(key: string): Promise<SignInAttempts | undefined>;
  countFailure(key: string, now: number, rule: LockoutRule): Promise<{ before: SignInAttempts | undefined; after: SignInAttempts }>;
  clearAttempts(key: string): Promise<void>;
}

export class MongoPlatformStore implements PlatformStore {
  constructor(private readonly db: () => Db) {}

  private get endedSessions() {
    return this.db().collection('endedSessions');
  }

  private get signInAttempts() {
    return this.db().collection('signInAttempts');
  }

  async ensureIndexes(): Promise<void> {
    await this.endedSessions.createIndex({ until: 1 }, { expireAfterSeconds: 0 });
    await this.endedSessions.createIndex({ at: 1 });
    await this.signInAttempts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
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
}
