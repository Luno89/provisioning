import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Collection, Db } from 'mongodb';
import type { DeferredConclusion, KeeperSettings } from './lib/conclusions.js';
import type { MemoryItem } from './lib/memory-store.js';

export interface MemoryStore extends AreaStore {
  getMemories(ownerId?: string): Promise<MemoryItem[]>;
  saveMemory(memory: MemoryItem): Promise<void>;
  getKeeperSettings(ownerId: string): Promise<KeeperSettings | undefined>;
  saveKeeperSettings(settings: KeeperSettings): Promise<void>;
  getDeferredConclusions(ownerId: string): Promise<DeferredConclusion[]>;
  saveDeferredConclusion(deferred: DeferredConclusion): Promise<void>;
  deleteDeferredConclusion(ownerId: string, id: string): Promise<void>;
  getMemoryWatermark(key: string): Promise<string | undefined>;
  saveMemoryWatermark(key: string, value: string): Promise<void>;
  deleteMemory(id: string): Promise<void>;
}

export class MongoMemoryStore implements MemoryStore {
  constructor(private readonly db: () => Db) {}

  private get memories(): Collection {
    return this.db().collection('memories');
  }

  async ensureIndexes(): Promise<void> {}

  async getMemories(ownerId?: string): Promise<MemoryItem[]> {
    const filter = ownerId ? { ownerId } : {};
    const docs = await this.memories.find(filter).toArray();
    return docs.map((d) => fromDoc<MemoryItem>(d));
  }

  async saveMemory(memory: MemoryItem): Promise<void> {
    const doc = toDoc(memory);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.memories.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async deleteMemory(id: string): Promise<void> {
    await this.memories.deleteOne({ _id: id as any });
  }

  async getKeeperSettings(ownerId: string): Promise<KeeperSettings | undefined> {
    const doc = await this.db().collection('keeperSettings').findOne({ _id: ownerId as never });
    if (!doc) return undefined;
    const { _id, ...rest } = doc as Record<string, unknown>;
    return { ...(rest as Omit<KeeperSettings, 'ownerId'>), ownerId: String(_id) };
  }

  async saveKeeperSettings(settings: KeeperSettings): Promise<void> {
    const { ownerId, ...rest } = settings;
    await this.db().collection('keeperSettings').replaceOne({ _id: ownerId as never }, rest, { upsert: true });
  }

  async getDeferredConclusions(ownerId: string): Promise<DeferredConclusion[]> {
    const docs = await this.db().collection('deferredConclusions').find({ ownerId }).sort({ at: 1 }).toArray();
    return docs.map(({ _id, ...rest }) => ({ ...(rest as Omit<DeferredConclusion, 'id'>), id: String(_id) }));
  }

  async saveDeferredConclusion(deferred: DeferredConclusion): Promise<void> {
    const { id, ...rest } = deferred;
    await this.db().collection('deferredConclusions').replaceOne({ _id: id as never }, rest, { upsert: true });
  }

  async deleteDeferredConclusion(ownerId: string, id: string): Promise<void> {
    await this.db().collection('deferredConclusions').deleteOne({ _id: id as never, ownerId });
  }

  async getMemoryWatermark(key: string): Promise<string | undefined> {
    const doc = await this.db().collection('memoryWatermarks').findOne({ _id: key as any });
    return typeof doc?.value === 'string' ? doc.value : undefined;
  }

  async saveMemoryWatermark(key: string, value: string): Promise<void> {
    await this.db().collection('memoryWatermarks').replaceOne({ _id: key as any }, { value }, { upsert: true });
  }
}
