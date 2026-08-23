/**
 * The pass that keeps the bank from becoming the bloat it exists to prevent.
 *
 * ── WHY THIS IS NOT OPTIONAL, AND WHY IT ARRIVED WITH memory-decide.ts ──
 * The review queue was the only thing bounding this bank's growth. Not by design — by neglect: 124
 * of 143 memories sat in it unread, so most of what the harness learned was stored, invisible, and
 * therefore harmless. Removing the gate makes every extraction live, which is the point, and it
 * removes the accidental brake at the same time.
 *
 * `admitMemory` handles the moment of writing, but it only ever sees five neighbours. It cannot
 * notice that a dozen entries written weeks apart have converged, cannot retire what has stopped
 * being consulted, and cannot repair an index that was wiped. Those are this file's job.
 *
 * ── DELIBERATELY MODEL-FREE ──
 * Every step below is a comparison over data already stored. No token cost, no model to be
 * unavailable, no judgement to be wrong — which matters for something that runs unattended on a
 * timer and edits the bank every other subsystem reads.
 *
 * ── AND DELIBERATELY IDEMPOTENT ──
 * Running twice in a row must change nothing the second time. That is the property that makes a
 * loop on a timer safe: it can fire during a leaf, overlap a deploy, or run fifty times overnight
 * without compounding. It is the first thing the tests check.
 */
import type { MemoryItem } from './memory-store.js';

export interface ConsolidationReport {
  at: string;
  /** Memories written into the search index that were missing from it. */
  indexed: number;
  /** Near-duplicates retired in favour of a newer entry. */
  deduped: number;
  /** Leaf findings turned into searchable memories. */
  promoted: number;
  /** Memories retired for never being consulted. */
  decayed: number;
  /** Memories retired because no leaf could ever have been shown them. */
  unreachable: number;
  /** How many are current afterwards. */
  live: number;
}

/**
 * How long a memory may go unconsulted before it is retired.
 *
 * ── USAGE, NOT AGE ──
 * Age cannot tell a load-bearing fact from noise: the repository layout is months old and read by
 * every leaf, while a lesson written this morning that nothing ever matches is already dead weight.
 * `lastUsedAt` is written by recall when a memory actually reaches a prompt — not when search
 * merely returns it — so this measures being useful rather than being findable.
 *
 * Generous, because retiring something still in use is the expensive mistake and the whole point of
 * a bank is to carry knowledge across long gaps between leaves on a project.
 */
export const DECAY_AFTER_DAYS = 45;

/**
 * Above this cosine, two memories are treated as the same thing said twice.
 *
 * High on purpose. Everything here is reversible, so the cost of being wrong is a field to clear —
 * but the cost of being aggressive is losing a real distinction, and two lessons about the same
 * subsystem legitimately sit around 0.90. Measured on this bank: the duplicates that actually
 * needed collapsing were byte-identical text under identical titles, which the title rule below
 * catches without needing a vector at all.
 */
export const DUPLICATE_SIMILARITY = 0.97;

/** Findings shorter than this are a status line, not knowledge worth carrying. */
const MIN_FINDING_CHARS = 200;

/**
 * How much of a finding is carried.
 *
 * A pointer, not the document. The full text stays on the leaf, and the memory exists so a later
 * leaf can discover that the question was already answered and where. At 1,200 four findings filled
 * four fifths of the entire memory budget and crowded out the project's own knowledge — measured on
 * the first pass that made them reachable.
 */
const MAX_FINDING_CHARS = 600;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Same owner, same project, same category — the only entries that can be duplicates of each other. */
const groupKey = (m: MemoryItem) => `${m.ownerId}::${m.projectId ?? ''}::${m.category}`;

const newestFirst = (a: MemoryItem, b: MemoryItem) =>
  String(b.createdAt).localeCompare(String(a.createdAt));

/**
 * Duplicates by title, needing no service at all.
 *
 * ── WHY TITLE IS A STRONG SIGNAL HERE SPECIFICALLY ──
 * `leaf-memory.ts` generates titles from a fixed handful of templates — "Repository layout",
 * "Promised a file it did not deliver", "Ran out of steps before finishing" — so every leaf that
 * fails the same way writes the same title. Measured live: five copies of one, four of another,
 * ranking above everything else in search because there were five of them.
 *
 * `supersede` only ever knew about "Repository layout", one hardcoded string, which is why the rest
 * accumulated. This is that rule, generalised, and it runs with Qdrant switched off.
 */
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

/**
 * Duplicates by meaning, for entries whose titles differ.
 *
 * `similar` is injected rather than called: it is a Qdrant round trip per memory, and the decision
 * about what to retire is worth testing without one. An empty result — the vector half being down —
 * degrades to the title rule above, which is the whole of what runs on a smaller platform.
 */
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

  // Newest first, so the survivor of any pair is the newer one and a chain of near-duplicates
  // collapses onto a single current entry rather than pointing at something already retired.
  for (const keep of [...live].sort(newestFirst)) {
    if (retired.has(keep.id)) continue;
    for (const hit of similar.get(keep.id) ?? []) {
      if (hit.score < threshold || retired.has(hit.id)) continue;
      const other = byId.get(hit.id);
      // Same group only. A high cosine across two projects means two projects have the same
      // problem, which is two facts, not one.
      if (!other || other.id === keep.id || groupKey(other) !== groupKey(keep)) continue;
      if (newestFirst(keep, other) > 0) continue; // `other` is newer; it will get its own turn.
      retired.add(other.id);
      retire.push({ ...other, invalidAt: now, supersededBy: keep.id, updatedAt: now });
    }
  }
  return retire;
}

/**
 * Retires what nothing has consulted.
 *
 * A memory that has never been selected at all is judged from `createdAt`, so a bank written before
 * `lastUsedAt` existed decays on the same clock rather than living forever on a missing field.
 */
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

/**
 * Turns what a research leaf found into something a later leaf can find.
 *
 * ── THE GAP THIS FILLS ──
 * `leaf.findings` is the entire durable output of every `repo: false` persona — Researcher, Framer,
 * Synthesist. It is written, it is fed to leaves that directly depend on it, and it is then
 * unreachable: nothing searches it, so a question answered thoroughly in March is answered again in
 * August. That is the same rediscovery `leaf-memory.ts` exists to stop, one level up.
 *
 * Only succeeded leaves, and only substantial findings — a two-line answer is a status update. The
 * title is derived from the leaf's, which makes the title-dedupe rule above the idempotence
 * mechanism: promoting the same leaf twice produces the same title and the second copy is retired
 * on the next pass. Nothing here needs to remember what it has already done.
 */
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
      /**
       * ── SCOPE IS DECIDED BY WHETHER THERE IS A PROJECT, AND THIS COST ELEVEN ROWS TO LEARN ──
       *
       * The first live pass promoted 11 findings and every one was unreachable. It wrote
       * `scope: 'project'` unconditionally while setting `projectId` only when the leaf had one —
       * and `buildMemoryContext` gives a project-scoped memory to a leaf only when the ids match,
       * so a project-scoped row with no project matches nothing. Written, embedded, indexed,
       * invisible. `leaf-memory.test.ts` documents the shape; this is it happening.
       *
       * Then the awkward part: research personas are exactly the ones with no project. `repo: false`
       * means no checkout, and neither the leaf nor its branch carries a project id — measured, 0 of
       * 11. So "require a project" is not a fix, it is a way of promoting nothing forever.
       *
       * Owner-global is therefore the only scope that reaches anything, and it is defensible for
       * this content specifically: a Researcher's answer is usually cross-project by nature ("how do
       * other harnesses do memory"), it is relevance-gated rather than always injected, the title
       * rule stops it being promoted twice, and usage-based decay retires it within 45 days if
       * nothing ever matches it. `ranked()` also puts project-scoped entries ahead of global ones in
       * the fallback ordering, so it competes for the budget rather than displacing local knowledge.
       *
       * Where a project IS known, it is used — the tighter scope is always preferred.
       */
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

/**
 * Memories that no leaf can ever be shown.
 *
 * A `scope: 'project'` row with no `projectId` matches nothing: `buildMemoryContext` requires the
 * ids to be equal, and a leaf with no project is given no project-scoped memories at all. Such a
 * row is not merely useless — it is counted, indexed, embedded, and returned by search as a
 * candidate that hydration then silently drops, so it consumes a ranking slot forever.
 *
 * A repair rather than a guard: the writers are fixed, and this retires what earlier ones produced.
 */
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
  /** Writes into the search index. Absent or failing means the bank is consolidated but not indexed. */
  index?: (items: MemoryItem[]) => Promise<{ vectors: number; documents: number }>;
  /** Nearest neighbours per memory id. Absent means dedupe runs on titles alone. */
  similar?: (ids: string[]) => Promise<Map<string, { id: string; score: number }[]>>;
  now?: () => string;
  newId?: () => string;
}

/**
 * One pass. Safe to run at any time, and a no-op when there is nothing to do.
 *
 * Order matters: promote before dedupe, so a promotion that duplicates an existing entry is retired
 * in the same pass rather than living until the next one; dedupe before decay, so a retired
 * duplicate is not also counted as decayed; index last, so what gets indexed is what survived.
 */
export async function consolidateMemories(deps: ConsolidateDeps): Promise<ConsolidationReport> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const newId = deps.newId ?? (() => `mem_dream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  let memories = await deps.db.getMemories();

  // First, because everything downstream is wasted on a row nothing can ever read.
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

  /**
   * Backfill: everything still current goes to the index.
   *
   * Unconditional rather than tracking what is missing. Qdrant replaces a point when the id matches,
   * so re-sending a memory that is already there costs one embedding and changes nothing — and this
   * is the ONLY path that repairs a collection that was wiped, which is worth more than the saving.
   */
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
