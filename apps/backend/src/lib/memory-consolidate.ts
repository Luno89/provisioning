import type { MemoryItem } from './memory-store.js';

export interface ConsolidationReport {
  at: string;
  indexed: number;
  deduped: number;
  promoted: number;
  decayed: number;
  unreachable: number;
  live: number;
}

export const DECAY_AFTER_DAYS = 45;

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
      retire.push({ ...m, invalidAt: now, supersededBy: keep!.id, updatedAt: now });
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
      retire.push({ ...other, invalidAt: now, supersededBy: keep.id, updatedAt: now });
    }
  }
  return retire;
}

export function planDecay(memories: MemoryItem[], now: string, afterDays = DECAY_AFTER_DAYS): MemoryItem[] {
  const cutoff = Date.parse(now) - afterDays * 24 * 60 * 60 * 1000;
  if (Number.isNaN(cutoff)) return [];

  return memories
    .filter((m) => {
      if (m.invalidAt) return false;
      const last = Date.parse(m.lastUsedAt ?? m.createdAt);
      return !Number.isNaN(last) && last < cutoff;
    })
    .map((m) => ({ ...m, invalidAt: now, updatedAt: now }));
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
    getMemories(ownerId?: string): Promise<MemoryItem[]>;
    saveMemory(m: MemoryItem): Promise<void>;
    getLeaves(): Promise<PromotableLeaf[]>;
  };
  index?: (items: MemoryItem[]) => Promise<{ vectors: number; documents: number }>;
  similar?: (ids: string[]) => Promise<Map<string, { id: string; score: number }[]>>;
  now?: () => string;
  newId?: () => string;
}

export async function consolidateMemories(deps: ConsolidateDeps): Promise<ConsolidationReport> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const newId = deps.newId ?? (() => `mem_dream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  let memories = await deps.db.getMemories();

  const unreachable = planUnreachable(memories, now);
  for (const m of unreachable) await deps.db.saveMemory(m).catch(() => undefined);
  const unreachableIds = new Set(unreachable.map((m) => m.id));
  memories = memories.map((m) => (unreachableIds.has(m.id) ? { ...m, invalidAt: now } : m));

  const promoted = planPromotions(await deps.db.getLeaves().catch(() => []), memories, now, newId);
  for (const m of promoted) await deps.db.saveMemory(m).catch(() => undefined);
  memories = [...memories, ...promoted];

  const byTitle = planTitleDedupe(memories, now);
  const retiredIds = new Set(byTitle.map((m) => m.id));

  const live = memories.filter((m) => !m.invalidAt && !retiredIds.has(m.id));
  const bySimilarity = deps.similar
    ? planSimilarityDedupe(live, await deps.similar(live.map((m) => m.id)).catch(() => new Map()), now)
    : [];

  const deduped = [...byTitle, ...bySimilarity];
  for (const m of deduped) await deps.db.saveMemory(m).catch(() => undefined);
  for (const m of deduped) retiredIds.add(m.id);

  const decayed = planDecay(memories.filter((m) => !retiredIds.has(m.id)), now);
  for (const m of decayed) await deps.db.saveMemory(m).catch(() => undefined);
  for (const m of decayed) retiredIds.add(m.id);

  const survivors = memories.filter((m) => !m.invalidAt && !retiredIds.has(m.id) && m.status !== 'pending_review');
  const indexed = deps.index
    ? await deps.index(survivors).then((r) => r.vectors).catch(() => 0)
    : 0;

  return {
    at: now,
    indexed,
    deduped: deduped.length,
    promoted: promoted.length,
    decayed: decayed.length,
    unreachable: unreachable.length,
    live: survivors.length,
  };
}
