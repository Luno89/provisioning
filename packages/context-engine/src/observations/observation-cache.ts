export interface CachedObservation {
  id: string;
  toolName: string;
  timestamp: string;
  content: string;
  maskedContent?: string;
  metadata?: Record<string, unknown>;
}

export class ObservationCache {
  private readonly store = new Map<string, CachedObservation>();
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  set(id: string, obs: Omit<CachedObservation, 'id' | 'timestamp'>): void {
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }
    this.store.set(id, {
      id,
      timestamp: new Date().toISOString(),
      ...obs,
    });
  }

  get(id: string): CachedObservation | undefined {
    return this.store.get(id);
  }

  has(id: string): boolean {
    return this.store.has(id);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
