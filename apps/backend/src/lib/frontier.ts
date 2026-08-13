/**
 * The queue of URLs an ingest still has to fetch.
 *
 * ── WHY THIS IS NOT A VARIABLE IN THE WORKFLOW ──
 * It was one, and that is a ceiling rather than a design. A Temporal workflow's variables live in
 * its event history, which is replayed in full on every worker that picks the workflow up. The
 * history warns at 10 MB and is refused at 50. Measured on a real 24-page ingest: 89,656 bytes of
 * history per page — so the old loop died somewhere around 550 pages, against a target measured in
 * terabytes.
 *
 * A frontier in a collection costs the workflow nothing but a count. It also survives
 * `continueAsNew`, which is what keeps the history bounded no matter how long the crawl runs.
 *
 * ── AND WHY `seen` IS AN INDEX ──
 * Deduplication used to be a `Set` held alongside it, with the same replay cost and the same
 * ceiling. The id is derived from the ingest and the URL, so a unique index refuses a second copy
 * without anything having to remember the first. A page linked from forty others is enqueued once
 * because the database says so, not because a set in memory happened to still be there.
 */

export type FrontierState = 'pending' | 'done';

export interface FrontierUrl {
  /** `${ingestId}:${url}` — deterministic, so the unique index performs the deduplication. */
  id: string;
  ingestId: string;
  url: string;
  /** Distance from the seed. Decides both ordering and whether this page's links are followed. */
  depth: number;
  /** How many of the crawl's keywords appear in the URL. Higher is fetched first. */
  rank: number;
  state: FrontierState;
}

export interface FrontierClaim {
  url: string;
  depth: number;
}

export function frontierRow(
  ingestId: string,
  url: string,
  depth: number,
  keywords: string[],
): FrontierUrl {
  return { id: `${ingestId}:${url}`, ingestId, url, depth, rank: keywordScore(url, keywords), state: 'pending' };
}

/**
 * How many of the crawl's keywords appear in a URL.
 *
 * Scored at enqueue rather than at read, because the ordering is the database's job now and an
 * index cannot sort by a function. Crude on purpose: the alternative is fetching a page to find out
 * whether it was worth fetching, which is the cost being avoided.
 */
export function keywordScore(url: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  const u = url.toLowerCase();
  return keywords.reduce((n, k) => n + (u.includes(k.toLowerCase()) ? 1 : 0), 0);
}

/**
 * The order pages come out of the frontier: shallow first, then by keyword score, then by URL.
 *
 * Breadth-first, so a depth limit means what it says. The final tiebreak on URL is not cosmetic —
 * the read has to be **deterministic**, because an activity that retries must return the same batch
 * it returned the first time. Two pages with equal depth and equal score would otherwise come back
 * in whatever order the storage engine felt like, and a retry would silently skip pages.
 */
export function frontierOrder(a: FrontierUrl, b: FrontierUrl): number {
  return a.depth - b.depth || b.rank - a.rank || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}

/**
 * Whether a page's links are worth collecting.
 *
 * At the last permitted depth the frontier is drained rather than grown, so a capped crawl ends on
 * pages it has instead of queueing thousands it will never reach.
 */
export function followsLinks(depth: number, maxDepth: number): boolean {
  return depth < maxDepth;
}
