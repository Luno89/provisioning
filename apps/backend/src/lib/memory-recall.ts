import { searchMemories, type MemoryEndpoints } from './memory-index.js';
import {
  selectForContext, renderMemoryContext, ranked,
  type MemoryItem, type MemoryContextOptions,
} from './memory-store.js';

export const RECALL_TIMEOUT_MS = 3_000;

export const PINNED_TITLES: readonly string[] = ['Repository layout'];

export const MAX_QUERY_CHARS = 2_000;

export interface RecallInput {
  memories: MemoryItem[];
  ownerId: string;
  projectId?: string | undefined;
  query: string;
  endpoints?: (() => Promise<MemoryEndpoints | undefined>) | undefined;
  timeoutMs?: number;
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

function within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export async function recallMemories(input: RecallInput): Promise<RecallOutcome> {
  const opts: MemoryContextOptions = { preRanked: true };

  const hits = input.endpoints && input.query.trim()
    ? await within((async () => {
      const ends = await input.endpoints!();
      if (!ends || (!ends.vectors && !ends.index)) return null;
      return searchMemories(ends, input.query, { ownerId: input.ownerId });
    })(), input.timeoutMs ?? RECALL_TIMEOUT_MS)
    : null;

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
  }).catch(() => undefined)));
}
