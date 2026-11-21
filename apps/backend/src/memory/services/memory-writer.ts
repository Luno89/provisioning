import { v4 as uuidv4 } from 'uuid';
import { DependencyDownError } from '../../platform/index.js';
import type { MemoryItem } from '../lib/memory-store.js';
import { indexesAlike } from '../lib/memory-index.js';
import { currentMemory, planMemoryForget, planMemoryWrite, type MemoryWrite } from '../lib/memory-writing.js';

export interface MemoryWriterStore {
  list(ownerId: string): Promise<MemoryItem[]>;
  save(item: MemoryItem): Promise<void>;
  index(items: MemoryItem[]): Promise<void>;
  unindex(ownerId: string, ids: string[]): Promise<void>;
}

export interface Kept { unindexed?: string }

export type MemoryWritten =
  | { refused: string }
  | { known: MemoryItem }
  | { saved: MemoryItem; replaced?: MemoryItem | undefined; unindexed?: string };

export type MemoryForgotten = { refused: string } | { retired: MemoryItem };

const withoutMark = ({ indexPending: _mark, ...item }: MemoryItem): MemoryItem => item;

async function indexed(store: Pick<MemoryWriterStore, 'save' | 'index'>, items: readonly MemoryItem[]): Promise<Kept> {
  const findable = items.filter(currentMemory);
  if (!findable.length) return {};
  try {
    await store.index(findable);
    return {};
  } catch (err) {
    for (const item of findable) await store.save({ ...item, indexPending: true });
    if (err instanceof DependencyDownError) return { unindexed: err.message };
    throw err;
  }
}

export function createMemoryWriter(options: { store: MemoryWriterStore; now?: (() => string) | undefined; newId?: (() => string) | undefined }) {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? uuidv4;
  const { store } = options;

  const retire = async (ownerId: string, items: readonly MemoryItem[]): Promise<void> => {
    if (!items.length) return;
    await store.unindex(ownerId, items.map((item) => item.id));
    for (const item of items) await store.save(withoutMark(item));
  };

  const keep = async (items: readonly MemoryItem[]): Promise<Kept> => {
    const toIndex: MemoryItem[] = [];
    for (const ownerId of new Set(items.map((item) => item.ownerId))) {
      const known = new Map((await store.list(ownerId)).map((item) => [item.id, item]));
      const mine = items.filter((item) => item.ownerId === ownerId);
      const inIndex = (item: MemoryItem): MemoryItem | undefined => {
        const was = known.get(item.id);
        return was && currentMemory(was) && !was.indexPending ? was : undefined;
      };
      const stale = mine.filter((item) => { const was = inIndex(item); return was && (!currentMemory(item) || !indexesAlike(was, item)); });
      if (stale.length) await store.unindex(ownerId, stale.map((item) => item.id));
      toIndex.push(...mine.filter((item) => { const was = inIndex(item); return !was || !indexesAlike(was, item); }));
    }
    for (const item of items) await store.save(withoutMark(item));
    return indexed(store, toIndex.map(withoutMark));
  };

  return {
    keep,
    retire,

    async save(write: MemoryWrite): Promise<MemoryWritten> {
      const at = now();
      const plan = planMemoryWrite(await store.list(write.ownerId), write, at, newId());
      if (!('item' in plan)) return plan;
      const { item, replacing } = plan;
      const replaced = replacing ? { ...replacing, invalidAt: at, supersededBy: item.id, updatedAt: at } : undefined;
      if (replaced) await store.unindex(write.ownerId, [replaced.id]);
      await store.save(item);
      if (replaced) await store.save(withoutMark(replaced));
      const { unindexed } = await indexed(store, [item]);
      return { saved: item, ...(replaced ? { replaced } : {}), ...(unindexed ? { unindexed } : {}) };
    },

    async forget(ownerId: string, id: string, why: string): Promise<MemoryForgotten> {
      const plan = planMemoryForget(await store.list(ownerId), ownerId, id, why, now());
      if ('refused' in plan) return plan;
      await retire(ownerId, [plan.retired]);
      return plan;
    },
  };
}

export type MemoryWriter = ReturnType<typeof createMemoryWriter>;

export interface PendingStore {
  list(ownerId?: string): Promise<MemoryItem[]>;
  save(item: MemoryItem): Promise<void>;
  index(items: MemoryItem[]): Promise<void>;
}

export async function indexPendingMemories(store: PendingStore): Promise<number> {
  const pending = (await store.list()).filter((item) => item.indexPending);
  const findable = pending.filter(currentMemory);
  if (findable.length) await store.index(findable.map(withoutMark));
  for (const item of pending) await store.save(withoutMark(item));
  return findable.length;
}

export const MEMORY_INDEX_PIECES = ['quickwit', 'qdrant', 'tei'] as const;

export interface AnsweringStates {
  whenAnswering(dependency: (typeof MEMORY_INDEX_PIECES)[number], heard: () => Promise<void> | void): void;
}

export function indexOnRecovery(states: AnsweringStates, catchUp: () => Promise<number>): void {
  let running: Promise<void> | undefined;
  let again = false;
  const once = (): Promise<void> => catchUp().then(() => undefined, (err: unknown) => {
    console.warn(`[memory] the memories written while the index was down wait for its next answer: ${(err as Error).message}`);
  });
  const heard = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await once();
      } while (again);
    })().finally(() => { running = undefined; });
    return running;
  };
  for (const piece of MEMORY_INDEX_PIECES) states.whenAnswering(piece, heard);
}
