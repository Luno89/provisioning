import type { MemoryIndex } from '../../platform/index.js';
import { searchMemories } from './memory-index.js';
import {
  selectForContext, renderMemoryContext, ranked,
  type MemoryItem, type MemoryContextOptions,
} from './memory-store.js';

export const PINNED_TITLES: readonly string[] = ['Repository layout'];

export const MAX_QUERY_CHARS = 2_000;

export interface RecallInput {
  memories: MemoryItem[];
  ownerId: string;
  projectId?: string | undefined;
  query: string;
  endpoints?: (() => Promise<MemoryIndex | undefined>) | undefined;
}

export interface RecallOutcome {
  context: string;
  selected: MemoryItem[];
  via: 'hybrid' | 'recency';
}

export function recallQuery(leaf: { title?: string; body?: string; expects?: string[] }): string {
  return [leaf.title ?? '', leaf.body ?? '', ...(leaf.expects ?? [])]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_QUERY_CHARS);
}

export function orderByRelevance(memories: MemoryItem[], rankedIds: readonly string[]): MemoryItem[] {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const out: MemoryItem[] = [];
  const taken = new Set<string>();

  const take = (m: MemoryItem | undefined) => {
    if (!m || taken.has(m.id)) return;
    taken.add(m.id);
    out.push(m);
  };

  ranked(memories.filter((m) => PINNED_TITLES.includes(m.title))).forEach(take);
  for (const id of rankedIds) take(byId.get(id));
  ranked(memories).forEach(take);

  return out;
}

async function searched(input: RecallInput): Promise<{ id: string }[] | null> {
  if (!input.endpoints || !input.query.trim()) return null;
  try {
    const ends = await input.endpoints();
    if (!ends || (!ends.vectors && !ends.index)) return null;
    return await searchMemories(ends, input.query, { ownerId: input.ownerId });
  } catch (err) {
    throw new Error(`memories could not be searched: ${(err as Error).message}`, { cause: err });
  }
}

export async function recallMemories(input: RecallInput): Promise<RecallOutcome> {
  const opts: MemoryContextOptions = { preRanked: true };
  const hits = await searched(input);
  const ordered = orderByRelevance(input.memories, (hits ?? []).map((h) => h.id));
  const { kept, dropped } = selectForContext(ordered, input.projectId, opts);

  return {
    context: renderMemoryContext(kept, dropped),
    selected: kept,
    via: hits && hits.length ? 'hybrid' : 'recency',
  };
}

export async function markUsed(
  db: { saveMemory(m: MemoryItem): Promise<void> },
  selected: MemoryItem[],
  now = new Date().toISOString(),
): Promise<void> {
  await Promise.all(selected.map((m) => db.saveMemory({
    ...m,
    lastUsedAt: now,
    useCount: (m.useCount ?? 0) + 1,
  }).catch((err: unknown) => {
    console.warn(`[Recall] could not record that memory ${m.id} was used: ${(err as Error).message}`);
  })));
}
