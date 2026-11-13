import type { Collection, Db, Document } from 'mongodb';
import type { Fence } from './fence.js';

const WRITES: ReadonlySet<string> = new Set([
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'bulkWrite',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete',
]);

function fencedCollection<T extends Document>(collection: Collection<T>, fence: Fence): Collection<T> {
  return new Proxy(collection, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && WRITES.has(property)) {
        return (...args: unknown[]) => fence.guard(() => (value as (...given: unknown[]) => Promise<unknown>).apply(target, args));
      }
      return (value as (...given: unknown[]) => unknown).bind(target);
    },
  });
}

export function fencedDb(db: Db, fence: Fence): Db {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === 'collection') {
        return <T extends Document>(...args: Parameters<Db['collection']>) => fencedCollection(target.collection<T>(...args), fence);
      }
      return typeof value === 'function' ? (value as (...given: unknown[]) => unknown).bind(target) : value;
    },
  });
}
