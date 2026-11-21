import type { AreaStore } from './lib/collection.js';
import type { Db } from 'mongodb';
import type { Store as SessionStore } from 'express-session';
import { MongoStore } from 'connect-mongo';
import { BROWSER_SESSION_SECONDS, type BrowserSessionsOf } from './lib/browser-session.js';
import type { MigrationRecord } from './lib/migrations.js';
import { attemptsKeptUntil, type LockoutRule, type SignInAttempts } from './lib/http-limits.js';
import { isDependencyId, type DependencyStateRow } from './lib/dependencies.js';

export interface PlatformStore extends AreaStore {
  hasMigration(name: string): Promise<boolean>;
  recordMigration(record: MigrationRecord): Promise<void>;
  browserSessions(): SessionStore;
  endBrowserSessions(of: BrowserSessionsOf): Promise<string[]>;
  attemptsOf(key: string): Promise<SignInAttempts | undefined>;
  countFailure(key: string, now: number, rule: LockoutRule): Promise<{ before: SignInAttempts | undefined; after: SignInAttempts }>;
  clearAttempts(key: string): Promise<void>;
  saveDependencyState(row: DependencyStateRow): Promise<void>;
  dependencyStates(): Promise<DependencyStateRow[]>;
}

const BROWSER_SESSIONS = 'browserSessions';

const PROCESSES: readonly string[] = ['backend', 'worker-host', 'worker-cluster', 'worker-engine'];

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

  private sessionStore: { db: Db; store: MongoStore } | undefined;

  browserSessions(): SessionStore {
    const db = this.db();
    if (this.sessionStore?.db !== db) {
      this.sessionStore = { db, store: MongoStore.create({ client: db.client, dbName: db.databaseName, collectionName: BROWSER_SESSIONS, stringify: false, ttl: BROWSER_SESSION_SECONDS, autoRemove: 'native' }) };
    }
    return this.sessionStore.store;
  }

  async endBrowserSessions(of: BrowserSessionsOf): Promise<string[]> {
    const sessions = this.db().collection(BROWSER_SESSIONS);
    const filter = 'sub' in of ? { $or: [{ 'session.person.sub': of.sub }, { 'session.account.sub': of.sub }] } : { 'session.person.rootSid': of.rootSid };
    const ids = (await sessions.find(filter, { projection: { _id: 1 } }).toArray()).map((doc) => String(doc._id));
    if (ids.length) await sessions.deleteMany({ _id: { $in: ids as never[] } });
    return ids;
  }

  private get dependencyStateRows() {
    return this.db().collection('dependencyStates');
  }

  private get signInAttempts() {
    return this.db().collection('signInAttempts');
  }

  async ensureIndexes(): Promise<void> {
    await this.signInAttempts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async hasMigration(name: string): Promise<boolean> {
    return Boolean(await this.db().collection('migrations').findOne({ _id: name as never }));
  }

  async recordMigration(record: MigrationRecord): Promise<void> {
    const { name, ...rest } = record;
    await this.db().collection('migrations').replaceOne({ _id: name as never }, rest, { upsert: true });
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
