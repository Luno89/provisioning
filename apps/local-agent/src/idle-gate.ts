export type Release = () => void;

export class IdleGate {
  private readonly holds = new Map<number, string>();
  private next = 0;
  private waiting: (() => void)[] = [];

  hold(what: string): Release {
    const id = this.next++;
    this.holds.set(id, what);
    return () => {
      if (!this.holds.delete(id)) return;
      if (this.holds.size === 0) this.wake();
    };
  }

  get idle(): boolean {
    return this.holds.size === 0;
  }

  busyWith(): string[] {
    const counts = new Map<string, number>();
    for (const what of this.holds.values()) counts.set(what, (counts.get(what) ?? 0) + 1);
    return [...counts.entries()].map(([what, count]) => (count > 1 ? `${count} × ${what}` : what)).sort();
  }

  whenIdle(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise((resolve) => { this.waiting.push(resolve); });
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }
}

export async function holding<T>(gate: IdleGate | undefined, what: string, work: () => Promise<T>): Promise<T> {
  const release = gate?.hold(what);
  try {
    return await work();
  } finally {
    release?.();
  }
}
