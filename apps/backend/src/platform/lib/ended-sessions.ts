export interface EndedSession {
  id: string;
  until: number;
  at: number;
}

export class EndedSessionList {
  private readonly ends = new Map<string, number>();
  private latest = 0;

  get size(): number {
    return this.ends.size;
  }

  get seenUpTo(): number {
    return this.latest;
  }

  add(ended: EndedSession): void {
    this.ends.set(ended.id, Math.max(this.ends.get(ended.id) ?? 0, ended.until));
    this.latest = Math.max(this.latest, ended.at);
  }

  load(ended: readonly EndedSession[]): void {
    for (const one of ended) this.add(one);
  }

  ended(id: string, now: number): boolean {
    const until = this.ends.get(id);
    return until !== undefined && until > now;
  }

  prune(now: number): void {
    for (const [id, until] of this.ends) if (until <= now) this.ends.delete(id);
  }
}
