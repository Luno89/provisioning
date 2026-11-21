import { at, listAt } from '../../platform/lib/json-shapes.js';
import { pointId } from '../../engine/lib/corpus-backend.js';
import { embed, ensureCollection, ensureIndex } from '../../engine/lib/corpus-client.js';
import { answered, bothOf } from '../../engine/lib/corpus-stores.js';
import {
  MEMORY_INDEX, MEMORY_COLLECTION, MEMORY_SEARCH_LIMIT, buildMemoryQuery, memoryIndexConfig,
  fuseRRF, type FusedHit, type MemoryDoc,
} from './memory-rank.js';
import type { MemoryItem } from './memory-store.js';
import type { MemoryIndexReach } from '../../platform/index.js';

export type MemoryUnindexer = (ownerId: string, ids: string[]) => Promise<void>;

export const unindexerFrom = (index: MemoryIndexReach): MemoryUnindexer =>
  async (_ownerId, ids) => removeMemories(index, ids);

export type MemorySearcher = (ownerId: string, query: string, limit: number) => Promise<string[]>;

export const searcherFrom = (index: MemoryIndexReach): MemorySearcher => async (ownerId, query, limit) => {
  if (limit < 1) return [];
  await bothOf(ensureMemoryIndex(index.index), ensureMemoryCollection(index.vectors));
  return (await searchMemories(index, query, { ownerId }, limit)).map((hit) => hit.id);
};

const memoryIdOf = (point: unknown): string => String(at(at(point, 'payload'), 'memory_id') ?? '');

export const ensureMemoryIndex = (index: MemoryIndexReach['index']): Promise<void> => ensureIndex(index, MEMORY_INDEX, memoryIndexConfig());

export const ensureMemoryCollection = (vectors: MemoryIndexReach['vectors']): Promise<void> => ensureCollection(vectors, MEMORY_COLLECTION);

async function ownersPoints(vectors: MemoryIndexReach['vectors'], ask: 'search' | 'recommend', asked: Record<string, unknown>, ownerId: string, limit: number): Promise<unknown[]> {
  const res = await vectors.fetch(`${vectors.base}/collections/${MEMORY_COLLECTION}/points/${ask}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': vectors.apiKey },
    body: JSON.stringify({
      ...asked,
      limit,
      with_payload: true,
      filter: { must: [{ key: 'owner_id', match: { value: ownerId } }] },
      params: { quantization: { rescore: true } },
    }),
  });
  return listAt(await answered(res, 'Qdrant', vectors), 'result');
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
  stores: MemoryIndexReach,
  items: MemoryItem[],
): Promise<{ vectors: number; documents: number }> {
  if (!items.length) return { vectors: 0, documents: 0 };

  const [vectors, documents] = await bothOf(embedMemories(stores, items), writeMemoryDocs(stores.index, items));
  return { vectors, documents };
}

async function embedMemories(ends: Pick<MemoryIndexReach, 'vectors' | 'embeddings'>, items: MemoryItem[]): Promise<number> {
  await ensureMemoryCollection(ends.vectors);

  const vectors = await embed(ends.embeddings, items.map(bodyOf));
  if (vectors.length !== items.length) {
    throw new Error(`Embedding returned ${vectors.length} vectors for ${items.length} memories.`);
  }

  const points = items.map((m, i) => ({
    id: pointId(m.id),
    vector: vectors[i]!,
    payload: docFor(m),
  }));

  const res = await ends.vectors.fetch(`${ends.vectors.base}/collections/${MEMORY_COLLECTION}/points?wait=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'api-key': ends.vectors.apiKey },
    body: JSON.stringify({ points }),
  });
  await answered(res, 'Qdrant', ends.vectors);
  return points.length;
}

async function writeMemoryDocs(index: MemoryIndexReach['index'], items: MemoryItem[]): Promise<number> {
  await ensureMemoryIndex(index);

  const ndjson = items.map((m) => JSON.stringify(docFor(m))).join('\n');
  const res = await index.fetch(`${index.base}/api/v1/${MEMORY_INDEX}/ingest?commit=force`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: ndjson,
  });
  await answered(res, 'Quickwit', index);
  return items.length;
}

export async function removeMemories(ends: Pick<MemoryIndexReach, 'index' | 'vectors'>, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { index, vectors } = ends;
  await bothOf(
    index.fetch(`${index.base}/api/v1/${MEMORY_INDEX}/delete-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: ids.map((id) => `memory_id:"${id}"`).join(' OR ') }),
    }).then((res) => answered(res, 'Quickwit', index)),
    vectors.fetch(`${vectors.base}/collections/${MEMORY_COLLECTION}/points/delete?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': vectors.apiKey },
      body: JSON.stringify({ points: ids.map(pointId) }),
    }).then((res) => answered(res, 'Qdrant', vectors)),
  );
}

export async function searchMemoryVectors(
  stores: Pick<MemoryIndexReach, 'vectors' | 'embeddings'>,
  query: string,
  scope: { ownerId: string },
  limit = MEMORY_SEARCH_LIMIT,
): Promise<string[]> {
  const [vector] = await embed(stores.embeddings, [query]);
  if (!vector) throw new Error('TEI answered with no vector for the search');

  return (await ownersPoints(stores.vectors, 'search', { vector }, scope.ownerId, limit)).map(memoryIdOf).filter(Boolean);
}

export async function searchMemoryIndex(
  index: MemoryIndexReach['index'],
  query: string,
  scope: { ownerId: string },
  limit = MEMORY_SEARCH_LIMIT,
): Promise<string[]> {
  const q = buildMemoryQuery(query, scope);
  const url = `${index.base}/api/v1/${MEMORY_INDEX}/search?query=${encodeURIComponent(q)}&max_hits=${limit}`;
  const body = await answered(await index.fetch(url), 'Quickwit', index);
  const seen = new Set<string>();
  for (const h of listAt(body, 'hits')) {
    const id = String(at(h, 'memory_id') ?? '');
    if (id) seen.add(id);
  }
  return [...seen];
}

export async function searchMemories(
  stores: MemoryIndexReach,
  query: string,
  scope: { ownerId: string },
  limit = MEMORY_SEARCH_LIMIT,
): Promise<FusedHit[]> {
  const [dense, sparse] = await bothOf(
    searchMemoryVectors(stores, query, scope, limit),
    searchMemoryIndex(stores.index, query, scope, limit),
  );
  return fuseRRF({ dense, sparse });
}

export async function similarTo(
  stores: Pick<MemoryIndexReach, 'vectors'>,
  memoryId: string,
  scope: { ownerId: string },
  limit = 10,
): Promise<{ id: string; score: number }[]> {
  return (await ownersPoints(stores.vectors, 'recommend', { positive: [pointId(memoryId)] }, scope.ownerId, limit))
    .map((p) => ({ id: memoryIdOf(p), score: Number(at(p, 'score') ?? 0) }))
    .filter((h) => h.id && h.id !== memoryId);
}
