import session from 'express-session';
import { heldBy, type BrowserSessionsOf } from '../lib/browser-session.js';
import { attemptsKeptUntil, type LockoutRule, type SignInAttempts } from '../lib/http-limits.js';
import type { MigrationRecord } from '../lib/migrations.js';
import type { PlatformStore } from '../store.js';
import type { DependencyStateRow } from '../lib/dependencies.js';
import { asStored } from './as-stored.js';
import { copied } from './memory-records.js';

interface Attempts {
  failures: number[];
  expiresAt: number;
}

export class MemoryPlatformStore implements PlatformStore {
  private readonly migrations = new Map<string, Omit<MigrationRecord, 'name'>>();
  private readonly signInAttempts = new Map<string, Attempts>();
  private readonly dependencyStateRows = new Map<string, DependencyStateRow>();

  async saveDependencyState(row: DependencyStateRow): Promise<void> {
    const { since, reason, ...rest } = row;
    this.dependencyStateRows.set(`${row.process}:${row.dependency}`, asStored({ ...rest, ...(since ? { since } : {}), ...(reason ? { reason } : {}) }));
  }

  async dependencyStates(): Promise<DependencyStateRow[]> {
    return copied([...this.dependencyStateRows.values()]);
  }

  async ensureIndexes(): Promise<void> {}

  private readonly sessions = new session.MemoryStore();

  browserSessions(): session.Store {
    return this.sessions;
  }

  async endBrowserSessions(of: BrowserSessionsOf): Promise<string[]> {
    const all = await new Promise<Record<string, session.SessionData>>((resolve, reject) => {
      this.sessions.all((err, found) => (err ? reject(err as Error) : resolve((found ?? {}) as Record<string, session.SessionData>)));
    });
    const ids = Object.entries(all).filter(([, held]) => heldBy(held, of)).map(([id]) => id);
    for (const id of ids) await new Promise<void>((resolve, reject) => { this.sessions.destroy(id, (err) => (err ? reject(err as Error) : resolve())); });
    return ids;
  }

  async hasMigration(name: string): Promise<boolean> {
    return this.migrations.has(name);
  }

  async recordMigration(record: MigrationRecord): Promise<void> {
    const { name, ...rest } = record;
    this.migrations.set(name, asStored(rest));
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
