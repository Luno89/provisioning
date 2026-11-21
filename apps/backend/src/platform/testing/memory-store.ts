import session from 'express-session';
import type { EndedSession } from '../lib/ended-sessions.js';
import { heldBy, type BrowserSessionsOf } from '../lib/browser-session.js';
import { attemptsKeptUntil, type LockoutRule, type SignInAttempts } from '../lib/http-limits.js';
import type { MigrationRecord } from '../lib/migrations.js';
import type { PlatformStore } from '../store.js';
import type { DependencyStateRow } from '../lib/dependencies.js';
import type { Watching } from '../lib/change-streams.js';
import { asStored } from './as-stored.js';
import { copied } from './memory-records.js';
import { fenceIdOf, type Closing, type KoalaProcess, type RaisedFence } from '../lib/fence.js';

interface Attempts {
  failures: number[];
  expiresAt: number;
}

export class MemoryPlatformStore implements PlatformStore {
  private readonly migrations = new Map<string, Omit<MigrationRecord, 'name'>>();
  private readonly endedSessions = new Map<string, { until: number; at: number }>();
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

  private readonly fences = new Map<string, RaisedFence>();
  private readonly acks = new Map<string, Set<string>>();
  private readonly beats = new Map<string, { name: string; at: string }>();
  private readonly fenceWatchers = new Set<(fence: RaisedFence) => void>();
  private readonly ackWatchers = new Set<(ack: { closing: Closing; process: string }) => void>();
  private readonly processWatchers = new Set<() => void>();

  private watching<T>(watchers: Set<T>, on: T): Watching {
    watchers.add(on);
    return { ready: Promise.resolve(), close: async () => { watchers.delete(on); } };
  }

  async raiseFence(closing: Closing, at: string): Promise<void> {
    const id = fenceIdOf(closing);
    const fence = this.fences.get(id) ?? { closing: { ...closing }, at, confirmed: false };
    this.fences.set(id, fence);
    for (const watcher of this.fenceWatchers) queueMicrotask(() => watcher(copied(fence)));
  }

  async fencesRaised(): Promise<RaisedFence[]> {
    return copied([...this.fences.values()]);
  }

  watchFences(on: (fence: RaisedFence) => void): Watching {
    return this.watching(this.fenceWatchers, on);
  }

  async ackFence(closing: Closing, process: string, _at: string): Promise<void> {
    const id = fenceIdOf(closing);
    this.acks.set(id, new Set([...(this.acks.get(id) ?? []), process]));
    for (const watcher of this.ackWatchers) queueMicrotask(() => watcher({ closing: { ...closing }, process }));
  }

  async fenceAcks(closing: Closing): Promise<string[]> {
    return [...(this.acks.get(fenceIdOf(closing)) ?? [])];
  }

  watchFenceAcks(on: (ack: { closing: Closing; process: string }) => void): Watching {
    return this.watching(this.ackWatchers, on);
  }

  async confirmFence(closing: Closing): Promise<void> {
    const id = fenceIdOf(closing);
    const fence = this.fences.get(id);
    if (fence) this.fences.set(id, { ...fence, confirmed: true });
    this.acks.delete(id);
  }

  async endFence(closing: Closing, liveWith: readonly string[]): Promise<void> {
    const id = fenceIdOf(closing);
    const fence = this.fences.get(id);
    if (fence) this.fences.set(id, { ...fence, endedWith: [...liveWith] });
  }

  async dropFence(closing: Closing): Promise<void> {
    const id = fenceIdOf(closing);
    this.acks.delete(id);
    this.fences.delete(id);
  }

  async beatProcess(process: KoalaProcess, at: string): Promise<void> {
    this.beats.set(process.id, { name: process.name, at });
    for (const watcher of this.processWatchers) queueMicrotask(() => watcher());
  }

  async forgetProcess(id: string): Promise<void> {
    this.beats.delete(id);
  }

  async processesSeenSince(at: string): Promise<KoalaProcess[]> {
    return [...this.beats.entries()].filter(([, beat]) => beat.at >= at).map(([id, beat]) => ({ id, name: beat.name }));
  }

  watchProcesses(on: () => void): Watching {
    return this.watching(this.processWatchers, on);
  }
}
