import type { Identified } from '../lib/collection.js';
import { asStored } from './as-stored.js';

export const copied = <T>(value: T): T => structuredClone(value);

export type Collections = Map<string, Map<string, unknown>>;

export function collectionIn<T>(collections: Collections, name: string): Map<string, T> {
  if (!collections.has(name)) collections.set(name, new Map<string, unknown>());
  return collections.get(name) as Map<string, T>;
}

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null;

export function keysWhere(collections: Collections, name: string, matches: (row: Row) => boolean): string[] {
  const rows = collections.get(name);
  if (!rows) return [];
  return [...rows].filter(([, row]) => isRow(row) && matches(row)).map(([key]) => key);
}

export function ownedKeys(collections: Collections, name: string, ownerId: string): string[] {
  return keysWhere(collections, name, (row) => row.ownerId === ownerId);
}

export function removeKeys(collections: Collections, name: string, keys: Iterable<string>): number {
  const rows = collections.get(name);
  if (!rows) return 0;
  let removed = 0;
  for (const key of keys) if (rows.delete(key)) removed += 1;
  return removed;
}

export function removeWhere(collections: Collections, name: string, matches: (row: Row) => boolean): number {
  return removeKeys(collections, name, keysWhere(collections, name, matches));
}

export function updateWhere(collections: Collections, name: string, matches: (row: Row) => boolean, change: (row: Row) => void): number {
  const rows = collections.get(name);
  if (!rows) return 0;
  const keys = keysWhere(collections, name, matches);
  for (const key of keys) change(rows.get(key) as Row);
  return keys.length;
}

export class MemoryRecords<T extends Identified> {
  constructor(private readonly rows: Map<string, T> = new Map<string, T>()) {}

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
