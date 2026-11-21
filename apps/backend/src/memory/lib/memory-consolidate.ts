import type { MemoryItem } from './memory-store.js';

export interface ConsolidationReport {
  at: string;
  indexed: number;
  deduped: number;
  promoted: number;
  unreachable: number;
  live: number;
}

export const DUPLICATE_SIMILARITY = 0.97;

const MIN_FINDING_CHARS = 200;

const MAX_FINDING_CHARS = 600;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const groupKey = (m: MemoryItem) => `${m.ownerId}::${m.projectId ?? ''}::${m.category}`;

const newestFirst = (a: MemoryItem, b: MemoryItem) =>
  String(b.createdAt).localeCompare(String(a.createdAt));

export function planTitleDedupe(memories: MemoryItem[], now: string): MemoryItem[] {
  const groups = new Map<string, MemoryItem[]>();
  for (const m of memories) {
    if (m.invalidAt) continue;
    const key = `${groupKey(m)}::${norm(m.title)}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }

  const retire: MemoryItem[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort(newestFirst);
    for (const m of rest) {
      retire.push({ ...m, invalidAt: now, mergedInto: keep!.id, updatedAt: now });
    }
  }
  return retire;
}

export function planSimilarityDedupe(
  memories: MemoryItem[],
  similar: Map<string, { id: string; score: number }[]>,
  now: string,
  threshold = DUPLICATE_SIMILARITY,
): MemoryItem[] {
  const live = memories.filter((m) => !m.invalidAt);
  const byId = new Map(live.map((m) => [m.id, m]));
  const retired = new Set<string>();
  const retire: MemoryItem[] = [];

  for (const keep of [...live].sort(newestFirst)) {
    if (retired.has(keep.id)) continue;
    for (const hit of similar.get(keep.id) ?? []) {
      if (hit.score < threshold || retired.has(hit.id)) continue;
      const other = byId.get(hit.id);
      if (!other || other.id === keep.id || groupKey(other) !== groupKey(keep)) continue;
      if (newestFirst(keep, other) > 0) continue;
      retired.add(other.id);
      retire.push({ ...other, invalidAt: now, mergedInto: keep.id, updatedAt: now });
    }
  }
  return retire;
}

export interface PromotableLeaf {
  id: string;
  ownerId: string;
  projectId?: string | undefined;
  title: string;
  findings?: string | undefined;
  status: string;
}

export function planPromotions(
  leaves: PromotableLeaf[],
  existing: MemoryItem[],
  now: string,
  newId: () => string,
): MemoryItem[] {
  const seen = new Set(existing.filter((m) => !m.invalidAt).map((m) => norm(m.title)));

  return leaves
    .filter((l) => l.status === 'succeeded'
      && (l.findings ?? '').trim().length >= MIN_FINDING_CHARS
      )
    .map((l) => ({
      id: newId(),
      ownerId: l.ownerId,
      ...(l.projectId ? { projectId: l.projectId } : {}),
      category: 'lessons_learned' as const,
      scope: (l.projectId ? 'project' : 'global') as 'project' | 'global',
      recommendedScope: 'project' as const,
      status: 'active' as const,
      title: `What "${l.title}" established`.slice(0, 200),
      text: l.findings!.trim().slice(0, MAX_FINDING_CHARS),
      source: 'post_run_extractor' as const,
      provenance: { taskId: l.id },
      validAt: now,
      createdAt: now,
      updatedAt: now,
    }))
    .filter((m) => !seen.has(norm(m.title)));
}

export function planUnreachable(memories: MemoryItem[], now: string): MemoryItem[] {
  return memories
    .filter((m) => !m.invalidAt && m.scope === 'project' && !m.projectId)
    .map((m) => ({ ...m, invalidAt: now, updatedAt: now }));
}

export interface ConsolidateDeps {
  db: {
    memory: {
      getMemories(ownerId?: string): Promise<MemoryItem[]>;
    };
    projects: {
      getLeaves(): Promise<PromotableLeaf[]>;
    };
  };
  retire: (retired: MemoryItem[]) => Promise<void>;
  keep: (items: MemoryItem[]) => Promise<{ unindexed?: string }>;
  similar?: (ids: string[]) => Promise<Map<string, { id: string; score: number }[]>>;
  now?: () => string;
  newId?: () => string;
  ownerId?: string | undefined;
}

export async function consolidateMemories(deps: ConsolidateDeps): Promise<ConsolidationReport> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const newId = deps.newId ?? (() => `mem_dream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  let memories = await deps.db.memory.getMemories(deps.ownerId);

  const retire = async (retiring: MemoryItem[]): Promise<void> => {
    if (retiring.length) await deps.retire(retiring);
  };

  const unreachable = planUnreachable(memories, now);
  await retire(unreachable);
  const unreachableIds = new Set(unreachable.map((m) => m.id));
  memories = memories.map((m) => (unreachableIds.has(m.id) ? { ...m, invalidAt: now } : m));

  const leaves = (await deps.db.projects.getLeaves()).filter((leaf) => !deps.ownerId || leaf.ownerId === deps.ownerId);
  const promoted = planPromotions(leaves, memories, now, newId);
  const promotion = promoted.length ? await deps.keep(promoted) : {};
  const indexed = promotion.unindexed ? 0 : promoted.length;
  memories = [...memories, ...promoted];

  const byTitle = planTitleDedupe(memories, now);
  const retiredIds = new Set(byTitle.map((m) => m.id));

  const live = memories.filter((m) => !m.invalidAt && !retiredIds.has(m.id));
  const bySimilarity = deps.similar
    ? planSimilarityDedupe(live, await deps.similar(live.map((m) => m.id)).catch((err: unknown) => {
      console.warn(`[Consolidate] the memory vectors could not be asked, so only memories with the same title are merged: ${(err as Error).message}`);
      return new Map<string, { id: string; score: number }[]>();
    }), now)
    : [];

  const deduped = [...byTitle, ...bySimilarity];
  await retire(deduped);
  for (const m of deduped) retiredIds.add(m.id);

  const survivors = memories.filter((m) => !m.invalidAt && !retiredIds.has(m.id) && m.status !== 'pending_review');

  return {
    at: now,
    indexed,
    deduped: deduped.length,
    promoted: promoted.length,
    unreachable: unreachable.length,
    live: survivors.length,
  };
}
