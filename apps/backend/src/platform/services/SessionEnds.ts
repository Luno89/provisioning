import { EndedSessionList, type EndedSession } from '../lib/ended-sessions.js';
import type { PlatformStore } from '../store.js';
import type { Watching } from '../lib/change-streams.js';

export class SessionEnds {
  private readonly list = new EndedSessionList();
  private watching: Watching | undefined;
  private readonly listeners: Array<(id: string) => void> = [];

  constructor(private readonly store: Pick<PlatformStore, 'endSession' | 'sessionsEndedSince' | 'watchSessionEnds'>, private readonly now: () => number = () => Date.now()) {}

  async load(): Promise<void> {
    this.list.load(await this.store.sessionsEndedSince(0));
  }

  onEnd(listener: (id: string) => void): void {
    this.listeners.push(listener);
  }

  async follow(): Promise<void> {
    if (this.watching) return;
    this.watching = this.store.watchSessionEnds((ended) => this.heard([ended]));
    await this.watching.ready;
    await this.load();
  }

  private heard(ended: readonly EndedSession[]): void {
    const now = this.now();
    this.list.prune(now);
    for (const one of ended) {
      const known = this.list.ended(one.id, now);
      this.list.add(one);
      if (!known) for (const listener of this.listeners) listener(one.id);
    }
  }

  async stop(): Promise<void> {
    await this.watching?.close();
    this.watching = undefined;
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
