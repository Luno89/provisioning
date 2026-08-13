/**
 * The calls to Quickwit, Qdrant and TEI. The half of the corpus backend that needs a service up.
 *
 * Split from corpus-backend.ts so the document shapes, the query construction and the merge can be
 * tested without deploying four things — see that file for what the corpus is and why it is these
 * services.
 *
 * Every function here is written to be safe to call twice. Ingestion retries, and an activity that
 * created an index the first time must not fail because it exists the second.
 */
import {
  indexConfig, collectionConfig, buildIndexQuery, chunksFor, pointId, mergeHits,
  SEARCH_LIMIT, type CorpusDoc, type CorpusHit,
} from './corpus-backend.js';
import { SNIPPET_CHARS } from './corpus.js';
import type { CorpusEndpoints } from './web-tools-resolver.js';

/** One index and one collection per platform. Tenancy is a field, not a namespace — see below. */
export const INDEX_ID = 'koala-corpus';
export const COLLECTION_ID = 'koala-corpus';

async function ok(res: Response, what: string): Promise<any> {
  if (!res.ok) {
    throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Creates the index if it is not there.
 *
 * One index for every tenant, scoped by an `owner_id` term rather than an index apiece. Quickwit
 * splits are per-index, and an index per tenant means a tiny split per tenant per commit — the
 * shape that makes object-storage search slow, since a query then has to open thousands of small
 * files instead of a few large ones. The tenancy cost is that scoping has to be right in one place,
 * which is `buildIndexQuery`.
 */
export async function ensureIndex(base: string): Promise<void> {
  const res = await fetch(`${base}/api/v1/indexes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(indexConfig(INDEX_ID)),
  });
  // 400 with "already exists" is success on a retry. Anything else is real.
  if (res.ok) return;
  const body = await res.text();
  if (/already exists/i.test(body)) return;
  throw new Error(`Could not create the corpus index: HTTP ${res.status} ${body.slice(0, 300)}`);
}

/**
 * Writes pages into the index.
 *
 * `commit=force` rather than the default: without it a page is searchable only after the commit
 * timeout, and an ingest that reports success and then finds nothing for the next thirty seconds is
 * indistinguishable from an ingest that silently stored nothing.
 */
export async function indexPages(base: string, docs: CorpusDoc[]): Promise<number> {
  if (!docs.length) return 0;
  const ndjson = docs.map((d) => JSON.stringify(d)).join('\n');
  const res = await fetch(`${base}/api/v1/${INDEX_ID}/ingest?commit=force`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: ndjson,
  });
  await ok(res, 'Quickwit refused the batch');
  return docs.length;
}

export async function searchIndex(
  base: string,
  phrase: string,
  scope: { ownerId: string; ingestId?: string | undefined; projectId?: string | undefined },
  limit = SEARCH_LIMIT,
): Promise<CorpusHit[]> {
  const query = buildIndexQuery(phrase, scope);
  const url = `${base}/api/v1/${INDEX_ID}/search?query=${encodeURIComponent(query)}&max_hits=${limit}`;
  const body = await ok(await fetch(url), 'Quickwit refused the search');
  const hits: any[] = Array.isArray(body?.hits) ? body.hits : [];
  return hits.map((h) => ({
    url: String(h?.url ?? ''),
    snippet: snippetAround(String(h?.body ?? ''), phrase),
    via: 'index' as const,
  })).filter((h) => h.url);
}

/**
 * Text around the match.
 *
 * Quickwit can return its own snippets, but only for fields configured for it, and its highlighting
 * markup would then have to be stripped before a model quotes it. Cutting the window here keeps
 * what reaches a prompt identical to what the substring search used to return.
 */
export function snippetAround(text: string, phrase: string): string {
  const at = text.toLowerCase().indexOf(phrase.trim().toLowerCase());
  const from = at === -1 ? 0 : Math.max(0, at - Math.floor(SNIPPET_CHARS / 2));
  const piece = text.slice(from, from + SNIPPET_CHARS).trim();
  return `${from > 0 ? '…' : ''}${piece}${from + SNIPPET_CHARS < text.length ? '…' : ''}`;
}

export async function embed(base: string, inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];
  const res = await fetch(`${base}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs, truncate: true }),
  });
  const body = await ok(res, 'The embedding service refused the batch');
  return Array.isArray(body) ? body : [];
}

export async function ensureCollection(base: string, apiKey: string): Promise<void> {
  const res = await fetch(`${base}/collections/${COLLECTION_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(collectionConfig()),
  });
  if (res.ok) return;
  const body = await res.text();
  if (/already exists/i.test(body)) return;
  throw new Error(`Could not create the vector collection: HTTP ${res.status} ${body.slice(0, 300)}`);
}

/**
 * Chunks pages, embeds them and stores the vectors.
 *
 * Returns how many chunks were written, so an ingest can report the semantic half separately —
 * embedding is the part most likely to be absent, and a corpus that is searchable by term but not
 * by meaning should say so rather than look complete.
 */
export async function embedPages(
  ends: Pick<CorpusEndpoints, 'vectors' | 'embeddings'>,
  docs: CorpusDoc[],
): Promise<number> {
  if (!ends.vectors || !ends.embeddings || !docs.length) return 0;

  const chunks = docs.flatMap((d) => chunksFor(d.url, d.body).map((c) => ({ ...c, doc: d })));
  if (!chunks.length) return 0;

  const vectors = await embed(ends.embeddings.base, chunks.map((c) => c.text));
  // A short reply means some inputs were dropped, and zipping by index would then attach vectors to
  // the wrong chunks — text that says one thing found by a vector meaning another.
  if (vectors.length !== chunks.length) {
    throw new Error(`Embedding returned ${vectors.length} vectors for ${chunks.length} chunks.`);
  }

  const points = chunks.map((c, i) => ({
    id: pointId(c.id),
    vector: vectors[i]!,
    payload: {
      url: c.url,
      text: c.text,
      ordinal: c.ordinal,
      owner_id: c.doc.owner_id,
      ingest_id: c.doc.ingest_id,
      project_id: c.doc.project_id,
    },
  }));

  const res = await fetch(`${ends.vectors.base}/collections/${COLLECTION_ID}/points?wait=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'api-key': ends.vectors.apiKey },
    body: JSON.stringify({ points }),
  });
  await ok(res, 'Qdrant refused the points');
  return points.length;
}

export async function searchVectors(
  ends: Pick<CorpusEndpoints, 'vectors' | 'embeddings'>,
  phrase: string,
  scope: { ownerId: string; ingestId?: string | undefined; projectId?: string | undefined },
  limit = SEARCH_LIMIT,
): Promise<CorpusHit[]> {
  if (!ends.vectors || !ends.embeddings) return [];
  const [vector] = await embed(ends.embeddings.base, [phrase]);
  if (!vector) return [];

  // Same reasoning as the index query: the owner is part of the search, not a filter applied to its
  // results.
  const must: unknown[] = [{ key: 'owner_id', match: { value: scope.ownerId } }];
  if (scope.ingestId) must.push({ key: 'ingest_id', match: { value: scope.ingestId } });
  if (scope.projectId) must.push({ key: 'project_id', match: { value: scope.projectId } });

  const res = await fetch(`${ends.vectors.base}/collections/${COLLECTION_ID}/points/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': ends.vectors.apiKey },
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      filter: { must },
      // Rescoring reads the full-precision vector from disk for the candidates the quantized
      // search returned. Without it the int8 approximation is the final ranking.
      params: { quantization: { rescore: true } },
    }),
  });
  const body = await ok(res, 'Qdrant refused the search');
  const found: any[] = Array.isArray(body?.result) ? body.result : [];
  return found.map((p) => ({
    url: String(p?.payload?.url ?? ''),
    snippet: String(p?.payload?.text ?? '').slice(0, SNIPPET_CHARS).trim(),
    via: 'vectors' as const,
  })).filter((h) => h.url);
}

/**
 * Both halves of the search, merged.
 *
 * Run together rather than one-then-the-other: they are independent round trips to different
 * services, and in series the slower one is simply added to the faster.
 *
 * A failing half must not take the search with it — a corpus with no embeddings deployed still answers
 * exact-term questions, and that is a better outcome than an error.
 */
export async function searchCorpus(
  ends: CorpusEndpoints,
  phrase: string,
  scope: { ownerId: string; ingestId?: string | undefined; projectId?: string | undefined },
): Promise<CorpusHit[]> {
  const [index, vectors] = await Promise.all([
    ends.index
      ? searchIndex(ends.index.base, phrase, scope).catch(() => [] as CorpusHit[])
      : Promise.resolve([] as CorpusHit[]),
    searchVectors(ends, phrase, scope).catch(() => [] as CorpusHit[]),
  ]);
  return mergeHits(index, vectors);
}
