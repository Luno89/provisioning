import { indexConfig, collectionConfig, chunksFor, pointId, type CorpusDoc } from './corpus-backend.js';
import type { MemoryIndex } from '../../platform/index.js';
import { answered, bothOf, refusal } from './corpus-stores.js';

export const INDEX_ID = 'koala-corpus';
export const COLLECTION_ID = 'koala-corpus';

const isVector = (value: unknown): value is number[] => Array.isArray(value) && value.every((entry) => typeof entry === 'number');

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
  throw refusal('Quickwit', res, body);
}

export async function indexPages(base: string, docs: CorpusDoc[]): Promise<number> {
  if (!docs.length) return 0;
  const ndjson = docs.map((d) => JSON.stringify(d)).join('\n');
  const res = await fetch(`${base}/api/v1/${INDEX_ID}/ingest?commit=force`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: ndjson,
  });
  await answered(res, 'Quickwit');
  return docs.length;
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
    const body = await answered(res, 'TEI');
    if (!Array.isArray(body)) continue;
    if (!body.every(isVector)) throw new Error('The embedding service answered with something that is not a list of vectors');
    out.push(...body);
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
  throw refusal('Qdrant', res, body);
}

export async function embedPages(
  stores: Pick<MemoryIndex, 'vectors' | 'embeddings'>,
  docs: CorpusDoc[],
): Promise<number> {
  if (!docs.length) return 0;

  const chunks = docs.flatMap((d) => chunksFor(d.url, d.body).map((c) => ({ ...c, doc: d })));
  if (!chunks.length) return 0;

  const vectors = await embed(stores.embeddings.base, chunks.map((c) => c.text));
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

  const res = await fetch(`${stores.vectors.base}/collections/${COLLECTION_ID}/points?wait=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'api-key': stores.vectors.apiKey },
    body: JSON.stringify({ points }),
  });
  await answered(res, 'Qdrant');
  return points.length;
}

export async function purgeCorpus(ends: Pick<MemoryIndex, 'index' | 'vectors'>, ingestId: string): Promise<void> {
  const { index, vectors } = ends;
  await bothOf(
    fetch(`${index.base}/api/v1/${INDEX_ID}/delete-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `ingest_id:"${ingestId}"` }),
    }).then((res) => answered(res, 'Quickwit')),
    fetch(`${vectors.base}/collections/${COLLECTION_ID}/points/delete?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': vectors.apiKey },
      body: JSON.stringify({ filter: { must: [{ key: 'ingest_id', match: { value: ingestId } }] } }),
    }).then((res) => answered(res, 'Qdrant')),
  );
}
