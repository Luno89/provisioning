import type { Collection as DriverCollection, Db, Document, Filter, IndexDescription, MongoClientOptions, Sort } from 'mongodb';

export type Identified = { id: string };

export const CLIENT_OPTIONS = { ignoreUndefined: true } as const;

export function connectsDirectly(uri: string): boolean {
  if (!uri.startsWith('mongodb://')) return false;
  const rest = uri.slice('mongodb://'.length);
  const query = rest.includes('?') ? rest.slice(rest.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  if (['replicaSet', 'directConnection', 'loadBalanced'].some((name) => params.has(name))) return false;
  const authority = rest.split(/[/?]/, 1)[0] ?? '';
  return !authority.slice(authority.lastIndexOf('@') + 1).includes(',');
}

export function clientOptionsFor(uri: string): MongoClientOptions {
  return connectsDirectly(uri) ? { ...CLIENT_OPTIONS, directConnection: true } : { ...CLIENT_OPTIONS };
}

export function fromDoc<T extends Identified>(doc: Document | null | undefined): T {
  if (!doc) return null as unknown as T;
  const result: Document = { ...doc };
  const rawId: unknown = result._id;
  if (rawId !== undefined && rawId !== null) {
    result.id = String(rawId);
  } else if (!result.id) {
    result.id = '';
  }
  const { _id, ...rest } = result;
  return rest as T;
}

export function toDoc<T extends Identified>(entity: T): Document {
  const { id, ...rest } = entity;
  return { ...rest, _id: id };
}

export interface FieldChanges {
  $set?: Document;
  $unset?: Record<string, ''>;
}

export function fieldChanges(fields: Record<string, unknown>): FieldChanges {
  const set = Object.entries(fields).filter(([, value]) => value !== undefined);
  const unset = Object.entries(fields).filter(([, value]) => value === undefined).map(([field]) => [field, ''] as const);
  return { ...(set.length ? { $set: Object.fromEntries(set) } : {}), ...(unset.length ? { $unset: Object.fromEntries(unset) } : {}) };
}

export class Records<T extends Identified> {
  constructor(private readonly db: () => Db, readonly name: string) {}

  get raw(): DriverCollection {
    return this.db().collection(this.name);
  }

  async all(filter: Filter<Document> = {}, sort?: Sort): Promise<T[]> {
    const cursor = this.raw.find(filter);
    const docs = await (sort ? cursor.sort(sort) : cursor).toArray();
    return docs.map((doc) => fromDoc<T>(doc));
  }

  async one(filter: Filter<Document>): Promise<T | undefined> {
    const doc = await this.raw.findOne(filter);
    return doc ? fromDoc<T>(doc) : undefined;
  }

  async byId(id: string): Promise<T | undefined> {
    return this.one({ _id: id as never });
  }

  async put(entity: T): Promise<void> {
    const { id, ...rest } = entity;
    await this.raw.replaceOne({ _id: id as never }, rest, { upsert: true });
  }

  async patch(id: string, fields: Partial<T>): Promise<void> {
    const changes = fieldChanges(fields);
    if (changes.$set || changes.$unset) await this.raw.updateOne({ _id: id as never }, changes);
  }

  async remove(id: string): Promise<void> {
    await this.raw.deleteOne({ _id: id as never });
  }

  async removeWhere(filter: Filter<Document>): Promise<number> {
    const { deletedCount } = await this.raw.deleteMany(filter);
    return deletedCount;
  }

  async count(filter: Filter<Document> = {}): Promise<number> {
    return this.raw.countDocuments(filter);
  }

  async indexes(descriptions: IndexDescription[]): Promise<void> {
    if (descriptions.length) await this.raw.createIndexes(descriptions);
  }
}

export interface AreaStore {
  ensureIndexes(): Promise<void>;
}
