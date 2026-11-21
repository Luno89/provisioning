import { at, listAt } from '../../platform/lib/json-shapes.js';
import { collectionConfig, pointId } from '../../engine/lib/corpus-backend.js';
import { embed } from '../../engine/lib/corpus-client.js';
import { answered, bothOf, refusal } from '../../engine/lib/corpus-stores.js';
import {
  MEMORY_INDEX, MEMORY_COLLECTION, MEMORY_SEARCH_LIMIT, buildMemoryQuery, memoryIndexConfig,
  fuseRRF, type FusedHit, type MemoryDoc,
} from './memory-rank.js';
import type { MemoryItem } from './memory-store.js';
import type { MemoryIndex } from '../../platform/index.js';

export type MemoryUnindexer = (ownerId: string, ids: string[]) => Promise<void>;

export const unindexerFrom = (index: MemoryIndex): MemoryUnindexer =>
  async (_ownerId, ids) => removeMemories(index, ids);

const memoryIdOf = (point: unknown): string => String(at(at(point, 'payload'), 'memory_id') ?? '');

const indexes = new Set<string>();
const collections = new Set<string>();

export async function ensureMemoryIndex(base: string): Promise<void> {
  if (indexes.has(base)) return;
  const res = await fetch(`${base}/api/v1/indexes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(memoryIndexConfig()),
  });
  if (res.ok) { indexes.add(base); return; }
  const body = await res.text();
  if (/already exist/i.test(body)) { indexes.add(base); return; }
  throw refusal('Quickwit', res, body);
}

export async function ensureMemoryCollection(base: string, apiKey: string): Promise<void> {
  if (collections.has(base)) return;
  const res = await fetch(`${base}/collections/${MEMORY_COLLECTION}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(collectionConfig()),
  });
  if (res.ok) { collections.add(base); return; }
  const body = await res.text();
  if (/already exist/i.test(body)) { collections.add(base); return; }
  throw refusal('Qdrant', res, body);
}

export const bodyOf = (m: MemoryItem) => `${m.title}. ${m.text}`;

const docFor = (m: MemoryItem): MemoryDoc => ({
  memory_id: m.id,
  owner_id: m.ownerId,
  project_id: m.projectId ?? '',
  category: m.category,
  scope: m.scope ?? 'global',
  body: bodyOf(m),
  created_at: m.createdAt,
});

export async function indexMemories(
  stores: MemoryIndex,
  items: MemoryItem[],
): Promise<{ vectors: number; documents: number }> {
  if (!items.length) return { vectors: 0, documents: 0 };

  const [vectors, documents] = await bothOf(embedMemories(stores, items), writeMemoryDocs(stores, items));
  return { vectors, documents };
}

async function embedMemories(ends: MemoryIndex, items: MemoryItem[]): Promise<number> {
  await ensureMemoryCollection(ends.vectors.base, ends.vectors.apiKey);

  const vectors = await embed(ends.embeddings.base, items.map(bodyOf));
  if (vectors.length !== items.length) {
    throw new Error(`Embedding returned ${vectors.length} vectors for ${items.length} memories.`);
  }

  const points = items.map((m, i) => ({
    id: pointId(m.id),
    vector: vectors[i]!,
    payload: docFor(m),
  }));

  const res = await fetch(`${ends.vectors.base}/collections/${MEMORY_COLLECTION}/points?wait=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'api-key': ends.vectors.apiKey },
    body: JSON.stringify({ points }),
  });
  await answered(res, 'Qdrant');
  return points.length;
}

async function writeMemoryDocs(ends: MemoryIndex, items: MemoryItem[]): Promise<number> {
  await ensureMemoryIndex(ends.index.base);

  const ndjson = items.map((m) => JSON.stringify(docFor(m))).join('\n');
  const res = await fetch(`${ends.index.base}/api/v1/${MEMORY_INDEX}/ingest?commit=force`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: ndjson,
  });
  await answered(res, 'Quickwit');
  return items.length;
}

export async function removeMemories(ends: Pick<MemoryIndex, 'index' | 'vectors'>, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { index, vectors } = ends;
  await bothOf(
    fetch(`${index.base}/api/v1/${MEMORY_INDEX}/delete-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: ids.map((id) => `memory_id:"${id}"`).join(' OR ') }),
    }).then((res) => answered(res, 'Quickwit')),
    fetch(`${vectors.base}/collections/${MEMORY_COLLECTION}/points/delete?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': vectors.apiKey },
      body: JSON.stringify({ points: ids.map(pointId) }),
    }).then((res) => answered(res, 'Qdrant')),
  );
}

export async function searchMemoryVectors(
  stores: Pick<MemoryIndex, 'vectors' | 'embeddings'>,
  query: string,
  scope: { ownerId: string },
  limit = MEMORY_SEARCH_LIMIT,
): Promise<string[]> {
  const [vector] = await embed(stores.embeddings.base, [query]);
  if (!vector) throw new Error('TEI answered with no vector for the search');

  const res = await fetch(`${stores.vectors.base}/collections/${MEMORY_COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': stores.vectors.apiKey },
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      filter: { must: [{ key: 'owner_id', match: { value: scope.ownerId } }] },
      params: { quantization: { rescore: true } },
    }),
  });
  const body = await answered(res, 'Qdrant');
  return listAt(body, 'result').map(memoryIdOf).filter(Boolean);
}

export async function searchMemoryIndex(
  base: string,
  query: string,
  scope: { ownerId: string },
  limit = MEMORY_SEARCH_LIMIT,
): Promise<string[]> {
  const q = buildMemoryQuery(query, scope);
  const url = `${base}/api/v1/${MEMORY_INDEX}/search?query=${encodeURIComponent(q)}&max_hits=${limit}`;
  const body = await answered(await fetch(url), 'Quickwit');
  const seen = new Set<string>();
  for (const h of listAt(body, 'hits')) {
    const id = String(at(h, 'memory_id') ?? '');
    if (id) seen.add(id);
  }
  return [...seen];
}

export async function searchMemories(
  stores: MemoryIndex,
  query: string,
  scope: { ownerId: string },
  limit = MEMORY_SEARCH_LIMIT,
): Promise<FusedHit[]> {
  const [dense, sparse] = await bothOf(
    searchMemoryVectors(stores, query, scope, limit),
    searchMemoryIndex(stores.index.base, query, scope, limit),
  );
  return fuseRRF({ dense, sparse });
}

export async function similarTo(
  stores: Pick<MemoryIndex, 'vectors'>,
  memoryId: string,
  scope: { ownerId: string },
  limit = 10,
): Promise<{ id: string; score: number }[]> {
  const res = await fetch(`${stores.vectors.base}/collections/${MEMORY_COLLECTION}/points/recommend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': stores.vectors.apiKey },
    body: JSON.stringify({
      positive: [pointId(memoryId)],
      limit,
      with_payload: true,
      filter: { must: [{ key: 'owner_id', match: { value: scope.ownerId } }] },
      params: { quantization: { rescore: true } },
    }),
  });
  const body = await answered(res, 'Qdrant');
  return listAt(body, 'result')
    .map((p) => ({ id: memoryIdOf(p), score: Number(at(p, 'score') ?? 0) }))
    .filter((h) => h.id && h.id !== memoryId);
}
