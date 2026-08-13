/**
 * The corpus as three services instead of an array in memory.
 *
 * ── WHAT THIS REPLACES ──
 * `search()` in corpus.ts loads every page an owner has into Node and scans each one with
 * `indexOf`. At the forty pages it was written against that is correct and instant. At the ninety-
 * five million a terabyte works out to it is not a slow search, it is an impossible one — the load
 * alone is the whole corpus through one process's heap.
 *
 * ── WHY PAGES LIVE IN QUICKWIT AND NOT IN A BUCKET ──
 * The obvious split was page text as objects in MinIO with an index beside it. That is two write
 * paths, two things to keep consistent, and a hand-rolled SigV4 client this repo has no dependency
 * for. Quickwit already stores what it indexes, and its splits already live in MinIO — so writing a
 * page to Quickwit puts the bytes in object storage AND makes them searchable in one call. MinIO is
 * still the thing holding the terabyte; it is just reached through the service that can find things
 * in it.
 *
 * ── AND WHY QDRANT IS SEPARATE ──
 * Exact terms and meaning are different questions. Quickwit answers "which pages contain this
 * phrase" over all of the corpus at no per-byte RAM cost. Qdrant answers "which chunks are about
 * this" over the part worth embedding — see qdrant-native.ts for why that cannot be everything.
 *
 * Pure helpers are exported separately from the calls that need a service, so the document shapes
 * and query construction can be tested without one running.
 */

/**
 * Characters per chunk, and the overlap between them.
 *
 * A chunk is what gets embedded, so it has to be small enough that one vector means one thing and
 * large enough to survive being read alone. The overlap exists because a sentence that straddles a
 * boundary is otherwise in neither chunk's meaning.
 */
export const CHUNK_CHARS = 800;
export const CHUNK_OVERLAP = 150;

/** bge-small-en-v1.5. Changing the model changes this, and the collection has to be rebuilt. */
export const VECTOR_SIZE = 384;

/** How many hits come back from either half of a search before merging. */
export const SEARCH_LIMIT = 12;

export interface CorpusDoc {
  url: string;
  host: string;
  owner_id: string;
  ingest_id: string;
  project_id: string;
  body: string;
  fetched_at: string;
}

export interface Chunk {
  id: string;
  url: string;
  text: string;
  ordinal: number;
}

/**
 * Splits a page into overlapping windows.
 *
 * Deliberately not sentence-aware. Sentence splitting on crawled markdown is a source of surprises
 * — code blocks, tables and link soup have no sentences in them — and a fixed window with overlap
 * degrades predictably where a clever splitter degrades unpredictably.
 */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const stride = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let at = 0; at < clean.length; at += stride) {
    const piece = clean.slice(at, at + size);
    // A trailing sliver shorter than the overlap is entirely contained in the previous chunk, so
    // it is a duplicate vector rather than a new one.
    if (piece.length < overlap && out.length) break;
    out.push(piece);
  }
  return out;
}

/**
 * Whether a chunk is worth a vector.
 *
 * Crawled documentation is mostly not prose. Measured on GitHub's rate-limit page: 18 of its 52
 * chunks are link lists, and the first is entirely `Skip to main content / GitHub Docs / Search or
 * ask Copilot` — a header that is byte-identical across every page on the site.
 *
 * Embedding those is worse than wasteful. Hundreds of near-identical nav chunks sit at roughly the
 * same distance from any query, so they crowd out the one chunk that answers it. The first semantic
 * search run here asked how to avoid being throttled and got webhooks and issue-dependencies back,
 * with the rate-limit page nowhere in the top three, while the exact-term half found it first try.
 *
 * Link density rather than a boilerplate list: it needs no per-site knowledge and it is the actual
 * property that makes a chunk meaningless to embed.
 */
export function worthEmbedding(text: string): boolean {
  const links = (text.match(/\]\(/g) ?? []).length;
  // Text outside the link syntax. A chunk that is nothing but a menu has almost none.
  const prose = text.replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (prose.length < 120) return false;
  // More than one link per forty characters of remaining prose is a list, not a paragraph.
  return links === 0 || prose.length / links > 40;
}

export function chunksFor(url: string, text: string): Chunk[] {
  return chunkText(text)
    .map((piece, i) => ({
      // Deterministic AND positional: the id is the chunk's index in the whole page, so filtering
      // some out does not renumber the rest. Re-ingesting a page must replace its chunks rather
      // than write a second set under shifted ids.
      id: `${url}#${i}`,
      url,
      text: piece,
      ordinal: i,
    }))
    .filter((c) => worthEmbedding(c.text));
}

/**
 * Qdrant point ids must be an unsigned integer or a UUID — a string like `https://x#3` is
 * rejected. Hashing keeps the id deterministic without keeping a mapping table.
 */
export function pointId(chunkId: string): string {
  let h1 = 0x9e3779b9, h2 = 0x85ebca6b;
  for (let i = 0; i < chunkId.length; i++) {
    h1 = Math.imul(h1 ^ chunkId.charCodeAt(i), 0x85ebca6b) >>> 0;
    h2 = Math.imul(h2 ^ chunkId.charCodeAt(i), 0xc2b2ae35) >>> 0;
  }
  // `>>> 0` before formatting, not decoration: `^` in JavaScript yields a SIGNED 32-bit int, and
  // `(-5).toString(16)` is "-5" — which produced a uuid with a minus sign in it that Qdrant would
  // have rejected at upsert, after a whole crawl had been embedded.
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  // Two 32-bit halves stretched over the 32 hex digits of a UUID, with the version nibble fixed so
  // Qdrant accepts it as one.
  const raw = `${hex(h1)}${hex(h2)}${hex(h1 ^ 0x5bf03635)}${hex(h2 ^ 0x27d4eb2f)}`;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

/**
 * The Quickwit query for a user's phrase, scoped to one owner.
 *
 * The scoping is not a filter applied afterwards — it is part of the query, because "search
 * everything then drop what is not yours" is one bad `if` away from being a cross-tenant leak.
 *
 * The phrase itself is quoted, and quotes inside it are dropped rather than escaped. This string
 * comes from a model: leaving it unquoted lets it inject field terms (`owner_id:someone-else`), and
 * escaping is a smaller, subtler surface to get wrong than removal.
 */
export function buildIndexQuery(
  phrase: string,
  scope: { ownerId: string; ingestId?: string | undefined; projectId?: string | undefined },
): string {
  const safe = phrase.replace(/["\\]/g, ' ').trim();
  const parts = [`owner_id:"${scope.ownerId}"`];
  if (scope.ingestId) parts.push(`ingest_id:"${scope.ingestId}"`);
  if (scope.projectId) parts.push(`project_id:"${scope.projectId}"`);
  if (safe) parts.push(`body:"${safe}"`);
  return parts.join(' AND ');
}

/** The index definition. Sent once; Quickwit answers 400 for an index that already exists. */
export function indexConfig(indexId: string): unknown {
  return {
    version: '0.8',
    index_id: indexId,
    doc_mapping: {
      field_mappings: [
        // `raw` tokenizer on the ids: these are matched whole, and the default tokenizer would
        // split a uuid on its hyphens and match any document sharing one segment.
        { name: 'url', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'host', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'owner_id', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'ingest_id', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'project_id', type: 'text', tokenizer: 'raw', stored: true },
        // `record: position` is what makes a quoted phrase a phrase rather than a bag of words.
        { name: 'body', type: 'text', tokenizer: 'default', record: 'position', stored: true },
        { name: 'fetched_at', type: 'datetime', fast: true, input_formats: ['rfc3339'], fast_precision: 'seconds' },
      ],
      timestamp_field: 'fetched_at',
    },
    search_settings: { default_search_fields: ['body'] },
    // Short, because an ingest that finishes and then cannot be searched for a minute reads as an
    // ingest that failed.
    indexing_settings: { commit_timeout_secs: 10 },
  };
}

/**
 * The Qdrant collection.
 *
 * Scalar int8 rather than binary quantization, which is the opposite of what the terabyte maths
 * suggests and is right for this vector: binary quantization needs the dimensions to carry enough
 * redundancy to survive being reduced to one bit each, and at 384 it does not — the recall loss is
 * real below about a thousand. int8 is a 4x reduction that keeps recall.
 *
 * Originals `on_disk` with the quantized copies in RAM is the pairing that matters: memory holds
 * something 4x smaller than the vectors, and the full-precision copy is only read to rescore the
 * handful of candidates a search actually returns.
 */
export function collectionConfig(): unknown {
  return {
    vectors: { size: VECTOR_SIZE, distance: 'Cosine', on_disk: true },
    quantization_config: { scalar: { type: 'int8', always_ram: true } },
  };
}

export interface CorpusHit {
  url: string;
  snippet: string;
  /** Which half of the search found it. Kept so an answer can say how it knows. */
  via: 'index' | 'vectors';
}

/**
 * Merges the two halves of a hybrid search.
 *
 * One hit per URL: the same page found by both halves is one source, and letting it appear twice
 * spends the budget on repetition. Exact matches come first — when someone searched for a phrase
 * and a page contains that phrase, that is not a result to bury under something merely related.
 */
export function mergeHits(index: CorpusHit[], vectors: CorpusHit[], limit = SEARCH_LIMIT): CorpusHit[] {
  const seen = new Set<string>();
  const out: CorpusHit[] = [];
  for (const hit of [...index, ...vectors]) {
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}
