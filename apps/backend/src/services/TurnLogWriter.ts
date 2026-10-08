import type { EngineEvent } from '@koala/agent-engine';
import { coalesce, type TurnLogEntry } from '../lib/turn-log.js';

export const TURN_LOG_FLUSH_MS = 150;

type Stamped = EngineEvent & { ownerId?: string; turnId?: string };

interface Pending {
  ownerId: string;
  events: EngineEvent[];
  timer?: ReturnType<typeof setTimeout> | undefined;
}

export class TurnLogWriter {
  private readonly pending = new Map<string, Pending>();
  private readonly lastSeq = new Map<string, number>();
  private readonly writing = new Map<string, Promise<void>>();
  private readonly flushMs: number;

  constructor(private readonly deps: {
    store: { appendTurnLog(entry: TurnLogEntry): Promise<void>; lastTurnLogSeq(turnId: string): Promise<number> };
    notify: (entry: TurnLogEntry) => void;
    flushMs?: number | undefined;
    now?: (() => Date) | undefined;
  }) {
    this.flushMs = deps.flushMs ?? TURN_LOG_FLUSH_MS;
  }

  accept(event: EngineEvent): void {
    const { ownerId, turnId, ...plain } = event as Stamped;
    if (!ownerId || !turnId) return;
    const turn = this.pending.get(turnId) ?? { ownerId, events: [] };
    turn.events.push(plain as EngineEvent);
    this.pending.set(turnId, turn);
    const ends = plain.runId === turnId && (plain.type === 'run.finished' || plain.type === 'interrupted');
    if (ends) {
      if (turn.timer) clearTimeout(turn.timer);
      turn.timer = undefined;
      void this.flush(turnId);
    } else if (!turn.timer) {
      turn.timer = setTimeout(() => { turn.timer = undefined; void this.flush(turnId); }, this.flushMs);
      turn.timer.unref?.();
    }
  }

  async drain(): Promise<void> {
    for (const turn of this.pending.values()) {
      if (turn.timer) clearTimeout(turn.timer);
      turn.timer = undefined;
    }
    await Promise.all([...this.pending.keys()].map((turnId) => this.flush(turnId)));
    await Promise.all(this.writing.values());
  }

  private flush(turnId: string): Promise<void> {
    const previous = this.writing.get(turnId) ?? Promise.resolve();
    const next = previous.then(() => this.write(turnId));
    this.writing.set(turnId, next);
    void next.finally(() => { if (this.writing.get(turnId) === next) this.writing.delete(turnId); });
    return next;
  }

  private async write(turnId: string): Promise<void> {
    const turn = this.pending.get(turnId);
    if (!turn || turn.events.length === 0) return;
    const events = turn.events.splice(0, turn.events.length);
    try {
      const seq = (this.lastSeq.get(turnId) ?? await this.deps.store.lastTurnLogSeq(turnId)) + 1;
      const entry: TurnLogEntry = { turnId, ownerId: turn.ownerId, seq, events: coalesce(events), at: (this.deps.now?.() ?? new Date()).toISOString() };
      await this.deps.store.appendTurnLog(entry);
      this.lastSeq.set(turnId, seq);
      this.deps.notify(entry);
      if (events.some((event) => event.runId === turnId && (event.type === 'run.finished' || event.type === 'interrupted'))) {
        this.lastSeq.delete(turnId);
        if (this.pending.get(turnId)?.events.length === 0) this.pending.delete(turnId);
      }
    } catch (err) {
      this.lastSeq.delete(turnId);
      turn.events.unshift(...events);
      console.warn(`[turn-log] could not write turn ${turnId}, trying again: ${(err as Error).message}`);
      if (!turn.timer) {
        turn.timer = setTimeout(() => { turn.timer = undefined; void this.flush(turnId); }, this.flushMs * 4);
        turn.timer.unref?.();
      }
    }
  }
}
