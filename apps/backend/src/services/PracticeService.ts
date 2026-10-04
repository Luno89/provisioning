import type { MemoryItem, PracticeTrial } from '../lib/memory-store.js';

export interface PracticeStore {
  getMemories(ownerId?: string): Promise<MemoryItem[]>;
  saveMemory(item: MemoryItem): Promise<void>;
}

export class PracticeService {
  constructor(private readonly deps: { store: PracticeStore; now?: () => string }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  async list(ownerId: string): Promise<MemoryItem[]> {
    return (await this.deps.store.getMemories(ownerId))
      .filter((memory) => memory.category === 'practice' && !memory.invalidAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async trials(ownerId: string): Promise<MemoryItem[]> {
    return (await this.list(ownerId)).filter((practice) => practice.status === 'trial');
  }

  async settle(ownerId: string, id: string, trial: PracticeTrial, live: boolean): Promise<void> {
    const practice = (await this.list(ownerId)).find((entry) => entry.id === id);
    if (!practice || practice.status !== 'trial') return;
    await this.deps.store.saveMemory({ ...practice, status: live ? 'active' : 'pending_review', trial, updatedAt: this.now() });
  }

  async makeLive(ownerId: string, id: string): Promise<MemoryItem | undefined> {
    const practice = (await this.list(ownerId)).find((entry) => entry.id === id);
    if (!practice || practice.status === 'active') return undefined;
    const live: MemoryItem = { ...practice, status: 'active', updatedAt: this.now() };
    await this.deps.store.saveMemory(live);
    return live;
  }

  async retire(ownerId: string, id: string): Promise<boolean> {
    const practice = (await this.list(ownerId)).find((entry) => entry.id === id);
    if (!practice) return false;
    await this.deps.store.saveMemory({ ...practice, invalidAt: this.now(), updatedAt: this.now() });
    return true;
  }
}
