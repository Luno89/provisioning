import { indexConfig, collectionConfig, chunksFor, pointId, type CorpusDoc } from './corpus-backend.js';
import type { MemoryIndexReach, Reaching } from '../../platform/index.js';
import { answered, bothOf, refusal } from './corpus-stores.js';

export const INDEX_ID = 'koala-corpus';
export const COLLECTION_ID = 'koala-corpus';

const isVector = (value: unknown): value is number[] => Array.isArray(value) && value.every((entry) => typeof entry === 'number');

const made = new Set<string>();

async function madeOnce(reach: Reaching & { base: string }, what: string, who: string, make: () => Promise<Response>): Promise<void> {
  const key = `${reach.base} ${what}`;
  if (made.has(key)) return;
  const res = await make();
  if (res.ok) { made.add(key); return; }
  const body = await res.text();
  if (/already exist/i.test(body)) { made.add(key); return; }
  throw reach.failed(refusal(who, res, body));
}

export const ensureIndex = (index: MemoryIndexReach['index'], id = INDEX_ID, config: unknown = indexConfig(INDEX_ID)): Promise<void> =>
  madeOnce(index, `index ${id}`, 'Quickwit', () => index.fetch(`${index.base}/api/v1/indexes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  }));

export const ensureCollection = (vectors: MemoryIndexReach['vectors'], name = COLLECTION_ID): Promise<void> =>
  madeOnce(vectors, `collection ${name}`, 'Qdrant', () => vectors.fetch(`${vectors.base}/collections/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'api-key': vectors.apiKey },
    body: JSON.stringify(collectionConfig()),
  }));

export async function indexPages(index: MemoryIndexReach['index'], docs: CorpusDoc[]): Promise<number> {
  if (!docs.length) return 0;
  const ndjson = docs.map((d) => JSON.stringify(d)).join('\n');
  const res = await index.fetch(`${index.base}/api/v1/${INDEX_ID}/ingest?commit=force`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: ndjson,
  });
  await answered(res, 'Quickwit', index);
  return docs.length;
}

export const EMBED_BATCH = 32;

export async function embed(embeddings: MemoryIndexReach['embeddings'], inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];

  const out: number[][] = [];
  for (let at = 0; at < inputs.length; at += EMBED_BATCH) {
    const res = await embeddings.fetch(`${embeddings.base}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: inputs.slice(at, at + EMBED_BATCH), truncate: true }),
    });
    const body = await answered(res, 'TEI', embeddings);
    if (!Array.isArray(body)) continue;
    if (!body.every(isVector)) throw new Error('The embedding service answered with something that is not a list of vectors');
    out.push(...body);
  }
  return out;
}

export async function embedPages(
  stores: Pick<MemoryIndexReach, 'vectors' | 'embeddings'>,
  docs: CorpusDoc[],
): Promise<number> {
  if (!docs.length) return 0;

  const chunks = docs.flatMap((d) => chunksFor(d.url, d.body).map((c) => ({ ...c, doc: d })));
  if (!chunks.length) return 0;

  const vectors = await embed(stores.embeddings, chunks.map((c) => c.text));
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

  const res = await stores.vectors.fetch(`${stores.vectors.base}/collections/${COLLECTION_ID}/points?wait=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'api-key': stores.vectors.apiKey },
    body: JSON.stringify({ points }),
  });
  await answered(res, 'Qdrant', stores.vectors);
  return points.length;
}

export async function purgeCorpus(ends: Pick<MemoryIndexReach, 'index' | 'vectors'>, ingestId: string): Promise<void> {
  const { index, vectors } = ends;
  await bothOf(
    index.fetch(`${index.base}/api/v1/${INDEX_ID}/delete-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `ingest_id:"${ingestId}"` }),
    }).then((res) => answered(res, 'Quickwit', index)),
    vectors.fetch(`${vectors.base}/collections/${COLLECTION_ID}/points/delete?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': vectors.apiKey },
      body: JSON.stringify({ filter: { must: [{ key: 'ingest_id', match: { value: ingestId } }] } }),
    }).then((res) => answered(res, 'Qdrant', vectors)),
  );
}
