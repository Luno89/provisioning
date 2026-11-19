import { ignore } from '@koala/engine-core/failures';
import { consolidateMemories, type ConsolidateDeps, type ConsolidationReport } from './memory-consolidate.js';
import { indexMemories, removeMemories, similarTo, type MemoryEndpoints } from './memory-index.js';

export type KeepingState =
  | { ownerId: string; state: 'kept'; at: string }
  | { ownerId: string; state: 'down'; since: string; reason: string; at: string };

export interface KeepingRecords {
  getKeepingState(ownerId: string): Promise<KeepingState | undefined>;
  saveKeepingState(state: KeepingState): Promise<void>;
}

export interface KeepingPlace {
  db: ConsolidateDeps['db'];
  reach: (ownerId: string) => Promise<MemoryEndpoints>;
  now?: (() => string) | undefined;
}

export interface KeepingEveryonePlace extends KeepingPlace {
  db: ConsolidateDeps['db'] & { memory: ConsolidateDeps['db']['memory'] & KeepingRecords };
}

export type KeepingOutcome =
  | { state: KeepingState & { state: 'kept' }; report: ConsolidationReport }
  | { state: KeepingState & { state: 'down' } };

export async function consolidateOwner(place: KeepingPlace, ownerId: string): Promise<ConsolidationReport> {
  const ends = await place.reach(ownerId);
  return consolidateMemories({
    db: place.db,
    ownerId,
    ...(place.now ? { now: place.now } : {}),
    unindex: async (retired) => removeMemories(ends, retired.map((memory) => memory.id)),
    index: (items) => indexMemories(ends, items),
    similar: async (ids: string[]) => {
      const out = new Map<string, { id: string; score: number }[]>();
      for (const id of ids) {
        out.set(id, await similarTo(ends, id, { ownerId }).catch(ignore('a memory the index cannot compare is left apart this pass and compared on the next')) ?? []);
      }
      return out;
    },
  });
}

export async function keepOwner(place: KeepingEveryonePlace, ownerId: string): Promise<KeepingOutcome> {
  const at = (place.now ?? (() => new Date().toISOString()))();
  const records = place.db.memory;
  try {
    const report = await consolidateOwner(place, ownerId);
    const state = { ownerId, state: 'kept' as const, at };
    await records.saveKeepingState(state);
    return { state, report };
  } catch (err) {
    const before = await records.getKeepingState(ownerId);
    const state = { ownerId, state: 'down' as const, since: before?.state === 'down' ? before.since : at, reason: err instanceof Error ? err.message : String(err), at };
    await records.saveKeepingState(state);
    return { state };
  }
}

export async function keepEveryOwner(place: KeepingEveryonePlace): Promise<KeepingOutcome[]> {
  const owners = [...new Set((await place.db.memory.getMemories()).map((memory) => memory.ownerId))];
  const outcomes: KeepingOutcome[] = [];
  for (const ownerId of owners) outcomes.push(await keepOwner(place, ownerId));
  return outcomes;
}
