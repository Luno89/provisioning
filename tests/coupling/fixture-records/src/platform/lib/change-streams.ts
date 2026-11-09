import type { Collection } from 'mongodb';

export function watchWrites(collection: () => Collection, on: () => void): void {
  collection().watch([]);
  on();
}
