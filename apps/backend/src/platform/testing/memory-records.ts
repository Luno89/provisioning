import type { Identified } from '../lib/collection.js';
import { asStored } from './as-stored.js';

export const copied = <T>(value: T): T => structuredClone(value);

export class MemoryRecords<T extends Identified> {
  private readonly rows = new Map<string, T>();

  all(): T[] {
    return [...this.rows.values()].map(copied);
  }

  get(id: string): T | undefined {
    const row = this.rows.get(id);
    return row ? copied(row) : undefined;
  }

  put(row: T): void {
    this.rows.set(row.id, asStored(row));
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }

  change(id: string, change: (row: T) => T | undefined): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    const next = change(copied(row));
    if (next === undefined) return false;
    this.rows.set(id, asStored(next));
    return true;
  }

  clear(): void {
    this.rows.clear();
  }
}
