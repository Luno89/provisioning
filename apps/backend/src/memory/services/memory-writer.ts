import { v4 as uuidv4 } from 'uuid';
import type { MemoryItem } from '../lib/memory-store.js';
import { planMemoryForget, planMemoryWrite, type MemoryWrite } from '../lib/memory-writing.js';

export interface MemoryWriterStore {
  list(ownerId: string): Promise<MemoryItem[]>;
  save(item: MemoryItem): Promise<void>;
  unindex(ownerId: string, ids: string[]): Promise<void>;
}

export type MemoryWritten =
  | { refused: string }
  | { known: MemoryItem }
  | { saved: MemoryItem; replaced?: MemoryItem | undefined };

export type MemoryForgotten = { refused: string } | { retired: MemoryItem };

export function createMemoryWriter(options: { store: MemoryWriterStore; now?: (() => string) | undefined; newId?: (() => string) | undefined }) {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? uuidv4;
  const { store } = options;

  return {
    async save(write: MemoryWrite): Promise<MemoryWritten> {
      const at = now();
      const plan = planMemoryWrite(await store.list(write.ownerId), write, at, newId());
      if (!('item' in plan)) return plan;
      const { item, replacing } = plan;
      if (replacing) await store.unindex(write.ownerId, [replacing.id]);
      await store.save(item);
      if (!replacing) return { saved: item };
      const replaced = { ...replacing, invalidAt: at, supersededBy: item.id, updatedAt: at };
      await store.save(replaced);
      return { saved: item, replaced };
    },

    async forget(ownerId: string, id: string, why: string): Promise<MemoryForgotten> {
      const plan = planMemoryForget(await store.list(ownerId), ownerId, id, why, now());
      if ('refused' in plan) return plan;
      await store.unindex(ownerId, [plan.retired.id]);
      await store.save(plan.retired);
      return plan;
    },
  };
}

export type MemoryWriter = ReturnType<typeof createMemoryWriter>;
