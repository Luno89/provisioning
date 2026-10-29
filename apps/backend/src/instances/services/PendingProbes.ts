export class PendingProbes {
  private readonly pending = new Set<string>();
  private readonly answers = new Map<string, boolean>();
  private readonly asked = new Set<string>();

  answered(key: string): boolean | undefined {
    if (!this.asked.has(key)) return undefined;
    return this.answers.get(key) === true;
  }

  ask(key: string, probe: () => Promise<boolean>): void {
    if (this.pending.has(key)) return;
    this.pending.add(key);
    this.answers.delete(key);
    this.asked.add(key);
    probe()
      .then((answered) => { this.answers.set(key, answered); }, () => { this.answers.set(key, false); })
      .finally(() => { this.pending.delete(key); });
  }
}
