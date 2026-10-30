import { EndedSessionList, type EndedSession } from '../lib/ended-sessions.js';
import type { PlatformStore } from '../store.js';

export const SESSION_ENDS_READ_EVERY_MS = 30_000;

export class SessionEnds {
  private readonly list = new EndedSessionList();
  private reading: ReturnType<typeof setInterval> | undefined;
  private readonly listeners: Array<(id: string) => void> = [];

  constructor(private readonly store: Pick<PlatformStore, 'endSession' | 'sessionsEndedSince'>, private readonly now: () => number = () => Date.now()) {}

  async load(): Promise<void> {
    this.list.load(await this.store.sessionsEndedSince(0));
  }

  onEnd(listener: (id: string) => void): void {
    this.listeners.push(listener);
  }

  private heard(ended: readonly EndedSession[]): void {
    const now = this.now();
    for (const one of ended) {
      const known = this.list.ended(one.id, now);
      this.list.add(one);
      if (!known) for (const listener of this.listeners) listener(one.id);
    }
  }

  keepReading(log: (message: string) => void, everyMs = SESSION_ENDS_READ_EVERY_MS): void {
    this.reading ??= setInterval(() => {
      this.list.prune(this.now());
      this.store.sessionsEndedSince(this.list.seenUpTo).then((ended) => this.heard(ended), (err: Error) => log(`[sessions] could not read the sessions signed out of: ${err.message}`));
    }, everyMs);
    this.reading.unref?.();
  }

  stop(): void {
    if (this.reading) clearInterval(this.reading);
    this.reading = undefined;
  }

  async end(id: string, until: number): Promise<void> {
    const ended = { id, until, at: this.now() };
    await this.store.endSession(ended);
    this.heard([ended]);
  }

  ended(id: string): boolean {
    return this.list.ended(id, this.now());
  }
}
