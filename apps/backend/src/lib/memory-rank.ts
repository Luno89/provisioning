/**
 * The shapes and the ranking for memory search. The half that needs nothing deployed.
 *
 * Split from memory-index.ts exactly as corpus-backend.ts is split from corpus-client.ts: the
 * document shape, the query construction and the fusion are the parts worth testing, and none of
 * them should need Qdrant, Quickwit and TEI running to be tested.
 *
 * ── WHY MEMORIES GET THEIR OWN INDEX AND COLLECTION ──
 * The corpus already owns `koala-corpus` in both services. Sharing it would put crawled web pages
 * and harness memories in one ranking, so every research search would return the harness's own
 * notes about its repositories and every memory recall would return whatever the user last crawled.
 * The payloads differ too — a memory has a category and a scope; a page has a URL and a host.
 */

/** One index and one collection for every tenant. Tenancy is a field, as it is for the corpus. */
export const MEMORY_INDEX = 'koala-memory';
export const MEMORY_COLLECTION = 'koala-memory';

/**
 * How many candidates each half returns before fusion.
 *
 * Twenty rather than the five that will be injected: fusion can only reorder what it is given, and
 * a memory ranked sixth by one half and first by the other is exactly the case RRF exists to catch.
 * Asking each half for only five would discard it before the fusion ran.
 */
export const MEMORY_SEARCH_LIMIT = 20;

/**
 * The RRF constant.
 *
 * 60 is the value from the original Cormack/Clarke/Buettcher paper and the one every system that
 * copies this uses. What it controls is how quickly rank position stops mattering: at k=60 the
 * difference between rank 1 and rank 2 is small, so a document both halves rank highly beats one
 * that either half ranks first alone. That is the behaviour we want — agreement between two
 * different notions of similarity is the strongest signal available without a reranker.
 */
export const RRF_K = 60;

export interface FusedHit {
  id: string;
  score: number;
  /** Which halves found it. Kept so a diagnostic can say why something ranked where it did. */
  via: string[];
}

/**
 * Reciprocal Rank Fusion over any number of ranked lists.
 *
 * `score = Σ 1/(k + rank)` across every list the id appears in, rank being 0-based here and 1-based
 * in the paper — a constant offset that shifts every score identically and so cannot change an
 * ordering.
 *
 * ── WHY FUSION RATHER THAN THE CORPUS'S MERGE ──
 * `mergeHits` (corpus-backend.ts:224) concatenates index hits then vector hits and dedupes. That
 * privileges exact-term matching unconditionally, which is right for a web corpus where someone
 * searched for a phrase and reasonable for nothing else. Here neither half is privileged: a leaf's
 * title shares few literal terms with a memory about the same subject, and a memory that both
 * halves rank at all is a better answer than one either ranks first.
 *
 * Scores are NOT comparable between the two engines — Qdrant returns cosine similarity and Quickwit
 * returns BM25 — which is the reason this fuses RANKS and never the scores themselves.
 */
export function fuseRRF(lists: Record<string, readonly string[]>, k = RRF_K): FusedHit[] {
  const scores = new Map<string, FusedHit>();
  /** First-seen order, so equal scores come out in a stable order rather than a hash order. */
  const order: string[] = [];

  for (const [via, ids] of Object.entries(lists)) {
    ids.forEach((id, rank) => {
      let hit = scores.get(id);
      if (!hit) {
        hit = { id, score: 0, via: [] };
        scores.set(id, hit);
        order.push(id);
      }
      hit.score += 1 / (k + rank);
      if (!hit.via.includes(via)) hit.via.push(via);
    });
  }

  return order
    .map((id) => scores.get(id)!)
    .sort((a, b) => b.score - a.score);
}

/**
 * The Quickwit query for a leaf's task, scoped to one owner.
 *
 * ── TERMS, NOT A PHRASE ──
 * `buildIndexQuery` quotes the whole phrase, because a corpus search is someone looking for words
 * they expect to be present. A leaf's title is not a phrase anyone wrote into a memory: "Add rate
 * limiting to the upload route" will never appear verbatim in a note about middleware. Quoted, this
 * half would return nothing on almost every leaf and the fusion would degrade to the dense half
 * alone. So the query is the terms, OR-ed, and BM25 does the ranking.
 *
 * ── AND WHY THE TERMS ARE REBUILT RATHER THAN ESCAPED ──
 * This text is model-adjacent — a leaf title can be anything a planner wrote. Unquoted terms are an
 * injection surface: a title containing `owner_id:someone-else` would otherwise become part of the
 * query. Rather than escape, every character that is not alphanumeric is a separator, so what
 * reaches Quickwit can only ever be words. `buildIndexQuery` makes the same choice for the same
 * reason and states it: removal is a smaller surface to get wrong than escaping.
 */
export function buildMemoryQuery(phrase: string, scope: { ownerId: string }): string {
  const terms = memoryTerms(phrase);
  const owner = `owner_id:"${scope.ownerId.replace(/["\\]/g, '')}"`;
  // No usable terms means no text query at all — the owner clause alone, which Quickwit answers
  // with that owner's most recent memories rather than an error.
  if (!terms.length) return owner;
  return `${owner} AND (${terms.map((t) => `body:${t}`).join(' OR ')})`;
}

/**
 * Query terms, and only the ones that can rank anything.
 *
 * Single and double characters are dropped because they match everything, and the count is capped
 * because a leaf `body` can be several paragraphs and a 400-term OR is a slow query that ranks no
 * better than its first two dozen terms.
 */
export const MAX_QUERY_TERMS = 24;

export function memoryTerms(phrase: string): string[] {
  const seen = new Set<string>();
  for (const word of phrase.toLowerCase().split(/[^a-z0-9]+/i)) {
    if (word.length < 3) continue;
    seen.add(word);
    if (seen.size >= MAX_QUERY_TERMS) break;
  }
  return [...seen];
}

/**
 * The Quickwit index definition for memories.
 *
 * `indexConfig` cannot be reused: its fields are web-page shaped (`url`, `host`, `ingest_id`,
 * `fetched_at`) and its timestamp field is when a page was fetched. Its two hard-won details are
 * carried across deliberately — the `raw` tokenizer on every id, so a uuid is matched whole rather
 * than split on its hyphens and matched against anything sharing a segment; and `record: 'position'`
 * on the body, which is what would make a quoted phrase a phrase if one is ever wanted here.
 */
export function memoryIndexConfig(indexId = MEMORY_INDEX): unknown {
  return {
    version: '0.8',
    index_id: indexId,
    doc_mapping: {
      field_mappings: [
        { name: 'memory_id', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'owner_id', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'project_id', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'category', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'scope', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'body', type: 'text', tokenizer: 'default', record: 'position', stored: true },
        { name: 'created_at', type: 'datetime', fast: true, input_formats: ['rfc3339'], fast_precision: 'seconds' },
      ],
      timestamp_field: 'created_at',
    },
    search_settings: { default_search_fields: ['body'] },
    // Same reasoning as the corpus: a write that is not searchable for a minute reads as a write
    // that failed. Memories are written at the end of a leaf and read at the start of the next one,
    // which can be seconds apart.
    indexing_settings: { commit_timeout_secs: 10 },
  };
}

/**
 * One indexed document.
 *
 * Title and text are indexed together as `body` rather than as two fields, because a title here is
 * a sentence ("Ran out of steps before finishing") rather than a label, and splitting them would
 * mean choosing a weighting between two fields that carry the same kind of language.
 */
export interface MemoryDoc {
  memory_id: string;
  owner_id: string;
  project_id: string;
  category: string;
  scope: string;
  body: string;
  created_at: string;
}
