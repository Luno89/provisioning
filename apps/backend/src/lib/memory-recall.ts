/**
 * Choosing which memories a leaf actually sees.
 *
 * ── WHAT WAS WRONG WITH THE OLD ANSWER ──
 * Selection was `scope, then newest first`. Nothing about it was relevance-aware: a leaf asked to
 * add rate limiting and a leaf asked to fix a flaky test received exactly the same block, because
 * the criterion was a date. Measured on this instance: 125 memories, 107 invisible behind the
 * review queue, and all 18 that were active were "Repository layout" — one per project. The one
 * genuinely useful entry was reaching prompts by accident of being recent, and everything the
 * harness had learned about failures was not reaching them at all.
 *
 * ── THE SHAPE ──
 * Hybrid search over the owner's bank, RRF-fused, then hydrated from Mongo — which stays the source
 * of truth. Qdrant and Quickwit only ever produce an ORDER; every question about whether a memory
 * may be shown at all is answered by `selectForContext` against the Mongo row.
 *
 * ── AND WHY IT CANNOT BREAK THE LEAF ──
 * Every failure — no endpoints, a dead service, a slow one, an empty result — falls through to the
 * previous scope-and-recency ordering. That is not politeness; it is what makes the vector stack
 * safe to depend on at all. Memory is an enhancement, not a dependency, and a leaf whose Qdrant was
 * down must be exactly as well off as a leaf run last week.
 */
import { searchMemories, type MemoryEndpoints } from './memory-index.js';
import {
  selectForContext, renderMemoryContext, ranked,
  type MemoryItem, type MemoryContextOptions,
} from './memory-store.js';

/**
 * The longest recall may take before the leaf goes on without it.
 *
 * Three seconds is generous for two local round trips, and it is paid ONCE per leaf at prompt-build
 * time rather than per turn — a leaf runs for minutes. The cap exists for the case where a service
 * is reachable but wedged, which is the failure that would otherwise hold a leaf open against its
 * own wall clock while contributing nothing.
 */
export const RECALL_TIMEOUT_MS = 3_000;

/**
 * Memories that are injected whether or not the search ranks them.
 *
 * ── WHY THERE IS AN EXCEPTION AT ALL ──
 * The repository layout is the single highest-value entry in the bank — it is the one that stops
 * the rediscovery `leaf-memory.ts` was written for, where a leaf spent its whole budget on `ls -la`
 * while three finished leaves had already built the thing it was standing in. And it is exactly the
 * entry hybrid search is worst at: a file listing shares no vocabulary with "add rate limiting to
 * the upload route", so it ranks nowhere on either half.
 *
 * Relevance decides everything else. This is one title, and it is a fact about the workspace rather
 * than a claim about the task.
 */
export const PINNED_TITLES: readonly string[] = ['Repository layout'];

/** Enough of the task to describe it. Longer inputs are truncated by TEI anyway. */
export const MAX_QUERY_CHARS = 2_000;

export interface RecallInput {
  /** Everything stored for this owner. Mongo is the source of truth; search only orders it. */
  memories: MemoryItem[];
  ownerId: string;
  projectId?: string | undefined;
  /** The task, as text. Built by `recallQuery`. */
  query: string;
  /**
   * How to reach the search stack. A thunk rather than a value so that resolving the endpoints is
   * INSIDE the timeout: `corpusEndpoints` may have to establish four port-forwards on a cold
   * backend, and that is precisely the slow case the cap exists for. Resolving it first and timing
   * only the query would leave the unbounded half unbounded.
   *
   * Returns undefined when the corpus stack is not deployed for this owner — recall then degrades
   * to recency, which is the documented fallback and not an error.
   */
  endpoints?: (() => Promise<MemoryEndpoints | undefined>) | undefined;
  timeoutMs?: number;
}

export interface RecallOutcome {
  /** The block to put in the system prompt. */
  context: string;
  /** What actually reached the prompt — the input to `lastUsedAt` bookkeeping. */
  selected: MemoryItem[];
  /** How the order was decided. Logged, so a quiet degradation is visible rather than assumed. */
  via: 'hybrid' | 'recency';
}

/** The task as one string: what the leaf is called, what it says, and what it must produce. */
export function recallQuery(leaf: { title?: string; body?: string; expects?: string[] }): string {
  return [leaf.title ?? '', leaf.body ?? '', ...(leaf.expects ?? [])]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_QUERY_CHARS);
}

/**
 * Pinned first, then relevance, then everything else by the old ordering.
 *
 * Pure, and the part worth testing: the tail matters as much as the head. A leaf must never end up
 * with LESS than it would have had before, so whatever search did not rank is appended in exactly
 * the scope-and-recency order that used to be the whole algorithm. If search returns nothing, this
 * function returns precisely the old list.
 */
export function orderByRelevance(memories: MemoryItem[], rankedIds: readonly string[]): MemoryItem[] {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const out: MemoryItem[] = [];
  const taken = new Set<string>();

  const take = (m: MemoryItem | undefined) => {
    if (!m || taken.has(m.id)) return;
    taken.add(m.id);
    out.push(m);
  };

  // Pinned entries, newest first — `supersede` should leave only one current layout per project,
  // and ordering here means a bank that somehow holds two prefers the recent one.
  ranked(memories.filter((m) => PINNED_TITLES.includes(m.title))).forEach(take);
  for (const id of rankedIds) take(byId.get(id));
  ranked(memories).forEach(take);

  return out;
}

/**
 * Resolves rather than rejects on timeout.
 *
 * The caller's next move is identical for "slow" and "failed", and a rejection would need a catch
 * around it to say so. A null means "search did not answer; use the fallback".
 */
function within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  // Cleared rather than left to fire: an uncleared timer is a live handle, so a recall that
  // answered in 40ms would still hold the process for the remaining three seconds. Harmless in a
  // long-lived worker, and enough to hang a test run that waits for the event loop to drain.
  ]).finally(() => clearTimeout(timer));
}

export async function recallMemories(input: RecallInput): Promise<RecallOutcome> {
  const opts: MemoryContextOptions = { preRanked: true };

  const hits = input.endpoints && input.query.trim()
    ? await within((async () => {
      const ends = await input.endpoints!();
      // Neither half deployed is not a failure, it is a smaller platform. Same answer either way.
      if (!ends || (!ends.vectors && !ends.index)) return null;
      return searchMemories(ends, input.query, { ownerId: input.ownerId });
    })(), input.timeoutMs ?? RECALL_TIMEOUT_MS)
    : null;

  const ordered = orderByRelevance(input.memories, (hits ?? []).map((h) => h.id));
  const { kept, dropped } = selectForContext(ordered, input.projectId, opts);

  return {
    context: renderMemoryContext(kept, dropped),
    selected: kept,
    // `hybrid` only when search actually answered. A null is a degradation and says so, so that
    // "recall is on" is never inferred from the feature being wired up.
    via: hits && hits.length ? 'hybrid' : 'recency',
  };
}

/**
 * Records that these memories were injected.
 *
 * Deliberately about what reached the PROMPT, not what search returned: a memory the search keeps
 * finding but the budget keeps cutting has not been used, and decay must not treat it as if it had.
 *
 * Best-effort and never awaited on the critical path — a bookkeeping write that fails must not cost
 * a leaf its run.
 */
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
