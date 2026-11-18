import { ignore } from '@koala/engine-core/failures';
import { consolidateMemories, type ConsolidateDeps, type ConsolidationReport } from './memory-consolidate.js';
import { indexMemories, removeMemories, similarTo, type MemoryEndpoints } from './memory-index.js';

export interface KeepingPlace {
  db: ConsolidateDeps['db'];
  reach: (ownerId: string) => Promise<MemoryEndpoints>;
  now?: (() => string) | undefined;
}

export async function consolidateOwner(place: KeepingPlace, ownerId: string): Promise<ConsolidationReport> {
  const ends = await place.reach(ownerId).catch(ignore('an owner with no search service has their memories consolidated without an index'));
  return consolidateMemories({
    db: place.db,
    ownerId,
    ...(place.now ? { now: place.now } : {}),
    unindex: async (retired) => removeMemories(await place.reach(ownerId), retired.map((memory) => memory.id)),
    ...(ends ? {
      index: (items) => indexMemories(ends, items),
      similar: async (ids: string[]) => {
        const out = new Map<string, { id: string; score: number }[]>();
        for (const id of ids) {
          out.set(id, await similarTo(ends, id, { ownerId }).catch(ignore('a memory the index cannot compare is left apart this pass and compared on the next')) ?? []);
        }
        return out;
      },
    } : {}),
  });
}
