import type { Collection as DriverCollection, Db, Document, Filter, IndexDescription, Sort } from 'mongodb';

export type Identified = { id: string };

export function fromDoc<T extends Identified>(doc: Document | null | undefined): T {
  if (!doc) return null as unknown as T;
  const result: Document = { ...doc };
  if (result._id !== undefined && result._id !== null) {
    result.id = typeof result._id === 'object' && typeof result._id.toString === 'function' ? result._id.toString() : String(result._id);
  } else if (!result.id) {
    result.id = '';
  }
  const { _id, ...rest } = result;
  return rest as T;
}

export function toDoc<T extends Identified>(entity: T): Document {
  const { id, ...rest } = entity as Document;
  return { ...rest, _id: id };
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
    const { _id, ...rest } = toDoc(entity);
    await this.raw.replaceOne({ _id }, rest, { upsert: true });
  }

  async patch(id: string, fields: Partial<T>): Promise<void> {
    await this.raw.updateOne({ _id: id as never }, { $set: fields as Document });
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
