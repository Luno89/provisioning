import type { EndedSession } from '../lib/ended-sessions.js';
import { attemptsKeptUntil, type LockoutRule, type SignInAttempts } from '../lib/http-limits.js';
import type { MigrationRecord } from '../lib/migrations.js';
import type { PlatformStore } from '../store.js';
import type { Watching } from '../lib/change-streams.js';
import { asStored } from './as-stored.js';
import { copied } from './memory-records.js';

interface Attempts {
  failures: number[];
  expiresAt: number;
}

export class MemoryPlatformStore implements PlatformStore {
  private readonly migrations = new Map<string, Omit<MigrationRecord, 'name'>>();
  private readonly endedSessions = new Map<string, { until: number; at: number }>();
  private readonly signInAttempts = new Map<string, Attempts>();

  async ensureIndexes(): Promise<void> {}

  async hasMigration(name: string): Promise<boolean> {
    return this.migrations.has(name);
  }

  async recordMigration(record: MigrationRecord): Promise<void> {
    const { name, ...rest } = record;
    this.migrations.set(name, asStored(rest));
  }

  async endSession(ended: EndedSession): Promise<void> {
    const until = Math.max(this.endedSessions.get(ended.id)?.until ?? ended.until, ended.until);
    this.endedSessions.set(ended.id, { until, at: ended.at });
    for (const watcher of this.sessionWatchers) queueMicrotask(() => watcher({ id: ended.id, until, at: ended.at }));
  }

  private readonly sessionWatchers = new Set<(ended: EndedSession) => void>();

  watchSessionEnds(on: (ended: EndedSession) => void): Watching {
    this.sessionWatchers.add(on);
    return { ready: Promise.resolve(), close: async () => { this.sessionWatchers.delete(on); } };
  }

  async sessionsEndedSince(at: number): Promise<EndedSession[]> {
    const now = Date.now();
    return [...this.endedSessions.entries()]
      .filter(([, ended]) => ended.at >= at && ended.until > now)
      .map(([id, ended]) => ({ id, until: ended.until, at: ended.at }));
  }

  async attemptsOf(key: string): Promise<SignInAttempts | undefined> {
    const attempts = this.signInAttempts.get(key);
    return attempts ? { failures: [...attempts.failures] } : undefined;
  }

  async countFailure(key: string, now: number, rule: LockoutRule): Promise<{ before: SignInAttempts | undefined; after: SignInAttempts }> {
    const previous = this.signInAttempts.get(key);
    const before = previous ? { failures: [...previous.failures] } : undefined;
    const after = { failures: [...(before?.failures ?? []).filter((at) => at > now - rule.windowMs), now] };
    this.signInAttempts.set(key, { failures: [...after.failures], expiresAt: attemptsKeptUntil({ failures: [now] }, rule) });
    return copied({ before, after });
  }

  async clearAttempts(key: string): Promise<void> {
    this.signInAttempts.delete(key);
  }
}
