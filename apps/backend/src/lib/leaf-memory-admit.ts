import type { Database } from './db-interface.js';
import type { Leaf } from './leaves.js';
import type { MemoryItem } from './memory-store.js';
import { admitMemory, type Decision } from './memory-decide.js';
import { searchMemories, indexMemories, bodyOf, type MemoryEndpoints } from './memory-index.js';
import { recallMemories, recallQuery, markUsed, type RecallOutcome } from './memory-recall.js';

export interface MemoryAdmitDeps {
  db: Pick<Database, 'getMemories' | 'saveMemory'>;
  ownerId: string;
  leafId: string;
  memoryEndpoints: () => Promise<MemoryEndpoints>;
  ask: (prompt: string) => Promise<string>;
}

export function createMemoryAdmitter(deps: MemoryAdmitDeps): (candidate: MemoryItem) => Promise<Decision> {
  return async (candidate: MemoryItem): Promise<Decision> => {
    const gate = {
      neighbours: async (m: MemoryItem) => {
        const ends = await deps.memoryEndpoints();
        const hits = await searchMemories(ends, bodyOf(m), { ownerId: deps.ownerId });
        const stored = await deps.db.getMemories(deps.ownerId);
        const byId = new Map(stored.map((x: MemoryItem) => [x.id, x]));
        const found = hits
          .map((h) => byId.get(h.id))
          .filter((x): x is MemoryItem => x !== undefined);
        return found.filter((x) => x.category === m.category
          && !x.invalidAt
          && x.id !== m.id
          && (x.projectId ?? '') === (m.projectId ?? '')
          && (x.scope ?? 'global') === (m.scope ?? 'global'));
      },
      ask: deps.ask,
    };

    const { decision, write } = await admitMemory(gate, candidate);
    for (const item of write) await deps.db.saveMemory(item).catch(() => undefined);

    const current = write.filter((m) => !m.invalidAt);
    if (current.length) {
      await deps.memoryEndpoints().then((ends) => indexMemories(ends, current)).catch(() => undefined);
    }

    console.log(`[leaf-memory-admit] ${deps.leafId}: memory "${candidate.title}" -> ${decision.action}`);
    return decision;
  };
}

export interface RecallLeafMemoryDeps {
  db: Pick<Database, 'getMemories' | 'saveMemory'>;
  memoryEndpoints: () => Promise<MemoryEndpoints>;
}

export async function recallLeafMemory(
  deps: RecallLeafMemoryDeps,
  leaf: Pick<Leaf, 'id' | 'title' | 'body' | 'expects' | 'ownerId'>,
  projectId: string | undefined,
): Promise<RecallOutcome> {
  const recalled = await recallMemories({
    memories: await deps.db.getMemories(leaf.ownerId).catch(() => []),
    ownerId: leaf.ownerId,
    projectId,
    query: recallQuery({
      title: leaf.title,
      ...(leaf.body ? { body: leaf.body } : {}),
      ...(leaf.expects?.length ? { expects: leaf.expects } : {}),
    }),
    endpoints: deps.memoryEndpoints,
  });

  if (recalled.selected.length) {
    console.log(`[leaf-memory-admit] ${leaf.id}: recalled ${recalled.selected.length} memories via ${recalled.via}`);
    void markUsed(deps.db, recalled.selected);
  }

  return recalled;
}
