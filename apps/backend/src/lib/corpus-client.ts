import {
  indexConfig, collectionConfig, buildIndexQuery, chunksFor, pointId, mergeHits,
  SEARCH_LIMIT, type CorpusDoc, type CorpusHit,
} from './corpus-backend.js';
import { SNIPPET_CHARS } from './corpus.js';
import type { CorpusEndpoints } from './web-tools-resolver.js';

export const INDEX_ID = 'koala-corpus';
export const COLLECTION_ID = 'koala-corpus';

async function ok(res: Response, what: string): Promise<any> {
  if (!res.ok) {
    throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

const created = new Set<string>();
const collections = new Set<string>();

export async function ensureIndex(base: string): Promise<void> {
  if (created.has(base)) return;
  const res = await fetch(`${base}/api/v1/indexes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(indexConfig(INDEX_ID)),
  });
  if (res.ok) { created.add(base); return; }
  const body = await res.text();
  if (/already exist/i.test(body)) { created.add(base); return; }
  throw new Error(`Could not create the corpus index: HTTP ${res.status} ${body.slice(0, 300)}`);
}

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

export function snippetAround(text: string, phrase: string): string {
  const at = text.toLowerCase().indexOf(phrase.trim().toLowerCase());
  const from = at === -1 ? 0 : Math.max(0, at - Math.floor(SNIPPET_CHARS / 2));
  const piece = text.slice(from, from + SNIPPET_CHARS).trim();
  return `${from > 0 ? '…' : ''}${piece}${from + SNIPPET_CHARS < text.length ? '…' : ''}`;
}

export const EMBED_BATCH = 32;

export async function embed(base: string, inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];

  const out: number[][] = [];
  for (let at = 0; at < inputs.length; at += EMBED_BATCH) {
    const res = await fetch(`${base}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: inputs.slice(at, at + EMBED_BATCH), truncate: true }),
    });
    const body = await ok(res, 'The embedding service refused the batch');
    if (Array.isArray(body)) out.push(...body);
  }
  return out;
}

export async function ensureCollection(base: string, apiKey: string): Promise<void> {
  if (collections.has(base)) return;
  const res = await fetch(`${base}/collections/${COLLECTION_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(collectionConfig()),
  });
  if (res.ok) { collections.add(base); return; }
  const body = await res.text();
  if (/already exist/i.test(body)) { collections.add(base); return; }
  throw new Error(`Could not create the vector collection: HTTP ${res.status} ${body.slice(0, 300)}`);
}

export async function embedPages(
  ends: Pick<CorpusEndpoints, 'vectors' | 'embeddings'>,
  docs: CorpusDoc[],
): Promise<number> {
  if (!ends.vectors || !ends.embeddings || !docs.length) return 0;

  const chunks = docs.flatMap((d) => chunksFor(d.url, d.body).map((c) => ({ ...c, doc: d })));
  if (!chunks.length) return 0;

  const vectors = await embed(ends.embeddings.base, chunks.map((c) => c.text));
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

export async function purgeCorpus(ends: CorpusEndpoints, ingestId: string): Promise<void> {
  await Promise.all([
    (async () => {
      if (!ends.index) return;
      const res = await fetch(`${ends.index.base}/api/v1/${INDEX_ID}/delete-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: `ingest_id:"${ingestId}"` }),
      });
      if (!res.ok) console.warn(`[Corpus] could not schedule index deletion: HTTP ${res.status}`);
    })(),
    (async () => {
      if (!ends.vectors) return;
      const res = await fetch(`${ends.vectors.base}/collections/${COLLECTION_ID}/points/delete?wait=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': ends.vectors.apiKey },
        body: JSON.stringify({ filter: { must: [{ key: 'ingest_id', match: { value: ingestId } }] } }),
      });
      if (!res.ok) console.warn(`[Corpus] could not delete vectors: HTTP ${res.status}`);
    })(),
  ]);
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
