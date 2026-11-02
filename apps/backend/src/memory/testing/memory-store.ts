import { asStored } from '../../platform/testing/as-stored.js';
import { copied, MemoryRecords } from '../../platform/testing/memory-records.js';
import type { DeferredConclusion, KeeperSettings } from '../lib/conclusions.js';
import type { MemoryItem } from '../lib/memory-store.js';
import type { MemoryStore } from '../store.js';

export class MemoryMemoryStore implements MemoryStore {
  private readonly memories = new MemoryRecords<MemoryItem>();
  private readonly keeperSettings = new Map<string, KeeperSettings>();
  private readonly deferred = new MemoryRecords<DeferredConclusion>();
  private readonly watermarks = new Map<string, string>();

  async ensureIndexes(): Promise<void> {}

  async getMemories(ownerId?: string): Promise<MemoryItem[]> {
    return this.memories.all().filter((memory) => !ownerId || memory.ownerId === ownerId);
  }

  async saveMemory(memory: MemoryItem): Promise<void> {
    this.memories.put(asStored(memory));
  }

  async deleteMemory(id: string): Promise<void> {
    this.memories.delete(id);
  }

  async getKeeperSettings(ownerId: string): Promise<KeeperSettings | undefined> {
    const settings = this.keeperSettings.get(ownerId);
    return settings ? copied(settings) : undefined;
  }

  async saveKeeperSettings(settings: KeeperSettings): Promise<void> {
    this.keeperSettings.set(settings.ownerId, asStored(settings));
  }

  async getDeferredConclusions(ownerId: string): Promise<DeferredConclusion[]> {
    return this.deferred.all()
      .filter((entry) => entry.ownerId === ownerId)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  async saveDeferredConclusion(deferred: DeferredConclusion): Promise<void> {
    this.deferred.put(asStored(deferred));
  }

  async deleteDeferredConclusion(ownerId: string, id: string): Promise<void> {
    if (this.deferred.get(id)?.ownerId === ownerId) this.deferred.delete(id);
  }

  async getMemoryWatermark(key: string): Promise<string | undefined> {
    return this.watermarks.get(key);
  }

  async saveMemoryWatermark(key: string, value: string): Promise<void> {
    this.watermarks.set(key, value);
  }
}
