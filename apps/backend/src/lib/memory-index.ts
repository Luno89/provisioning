import { collectionConfig, pointId } from './corpus-backend.js';
import { embed } from './corpus-client.js';
import {
  MEMORY_INDEX, MEMORY_COLLECTION, MEMORY_SEARCH_LIMIT, buildMemoryQuery, memoryIndexConfig,
  fuseRRF, type FusedHit, type MemoryDoc,
} from './memory-rank.js';
import type { MemoryItem } from './memory-store.js';
import type { CorpusEndpoints } from './web-tools-resolver.js';

export type MemoryEndpoints = Pick<CorpusEndpoints, 'vectors' | 'embeddings' | 'index'>;

async function ok(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

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
  throw new Error(`Could not create the memory index: HTTP ${res.status} ${body.slice(0, 300)}`);
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
  throw new Error(`Could not create the memory collection: HTTP ${res.status} ${body.slice(0, 300)}`);
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
  ends: MemoryEndpoints,
  items: MemoryItem[],
): Promise<{ vectors: number; documents: number }> {
  if (!items.length) return { vectors: 0, documents: 0 };

  const [vectors, documents] = await Promise.all([
    embedMemories(ends, items).catch((err: Error) => {
      console.warn(`[MemoryIndex] could not embed: ${err.message}`);
      return 0;
    }),
    writeMemoryDocs(ends, items).catch((err: Error) => {
      console.warn(`[MemoryIndex] could not index: ${err.message}`);
      return 0;
    }),
  ]);
  return { vectors, documents };
}

async function embedMemories(ends: MemoryEndpoints, items: MemoryItem[]): Promise<number> {
  if (!ends.vectors || !ends.embeddings) return 0;
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
  await ok(res, 'Qdrant refused the memory points');
  return points.length;
}

async function writeMemoryDocs(ends: MemoryEndpoints, items: MemoryItem[]): Promise<number> {
  if (!ends.index) return 0;
  await ensureMemoryIndex(ends.index.base);

  const ndjson = items.map((m) => JSON.stringify(docFor(m))).join('\n');
  const res = await fetch(`${ends.index.base}/api/v1/${MEMORY_INDEX}/ingest?commit=force`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: ndjson,
  });
  await ok(res, 'Quickwit refused the memory batch');
  return items.length;
}

export async function removeMemories(ends: MemoryEndpoints, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await Promise.all([
    (async () => {
      if (!ends.index) return;
      const res = await fetch(`${ends.index.base}/api/v1/${MEMORY_INDEX}/delete-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: ids.map((id) => `memory_id:"${id}"`).join(' OR ') }),
      });
      if (!res.ok) console.warn(`[MemoryIndex] could not schedule deletion: HTTP ${res.status}`);
    })(),
    (async () => {
      if (!ends.vectors) return;
      const res = await fetch(`${ends.vectors.base}/collections/${MEMORY_COLLECTION}/points/delete?wait=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': ends.vectors.apiKey },
        body: JSON.stringify({ points: ids.map(pointId) }),
      });
      if (!res.ok) console.warn(`[MemoryIndex] could not delete vectors: HTTP ${res.status}`);
    })(),
  ]);
}

export async function searchMemoryVectors(
  ends: MemoryEndpoints,
  query: string,
  scope: { ownerId: string },
  limit = MEMORY_SEARCH_LIMIT,
): Promise<string[]> {
  if (!ends.vectors || !ends.embeddings) return [];
  const [vector] = await embed(ends.embeddings.base, [query]);
  if (!vector) return [];

  const res = await fetch(`${ends.vectors.base}/collections/${MEMORY_COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': ends.vectors.apiKey },
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      filter: { must: [{ key: 'owner_id', match: { value: scope.ownerId } }] },
      params: { quantization: { rescore: true } },
    }),
  });
  const body = await ok(res, 'Qdrant refused the memory search');
  const found: any[] = Array.isArray(body?.result) ? body.result : [];
  return found.map((p) => String(p?.payload?.memory_id ?? '')).filter(Boolean);
}

export async function searchMemoryIndex(
  base: string,
  query: string,
  scope: { ownerId: string },
  limit = MEMORY_SEARCH_LIMIT,
): Promise<string[]> {
  const q = buildMemoryQuery(query, scope);
  const url = `${base}/api/v1/${MEMORY_INDEX}/search?query=${encodeURIComponent(q)}&max_hits=${limit}`;
  const body = await ok(await fetch(url), 'Quickwit refused the memory search');
  const hits: any[] = Array.isArray(body?.hits) ? body.hits : [];

  const seen = new Set<string>();
  for (const h of hits) {
    const id = String(h?.memory_id ?? '');
    if (id) seen.add(id);
  }
  return [...seen];
}

export async function searchMemories(
  ends: MemoryEndpoints,
  query: string,
  scope: { ownerId: string },
  limit = MEMORY_SEARCH_LIMIT,
): Promise<FusedHit[]> {
  const [dense, sparse] = await Promise.all([
    searchMemoryVectors(ends, query, scope, limit).catch(() => [] as string[]),
    ends.index
      ? searchMemoryIndex(ends.index.base, query, scope, limit).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ]);
  return fuseRRF({ dense, sparse });
}

export async function similarTo(
  ends: MemoryEndpoints,
  memoryId: string,
  scope: { ownerId: string },
  limit = 10,
): Promise<{ id: string; score: number }[]> {
  if (!ends.vectors) return [];
  const res = await fetch(`${ends.vectors.base}/collections/${MEMORY_COLLECTION}/points/recommend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': ends.vectors.apiKey },
    body: JSON.stringify({
      positive: [pointId(memoryId)],
      limit,
      with_payload: true,
      filter: { must: [{ key: 'owner_id', match: { value: scope.ownerId } }] },
      params: { quantization: { rescore: true } },
    }),
  });
  const body = await ok(res, 'Qdrant refused the neighbour lookup');
  const found: any[] = Array.isArray(body?.result) ? body.result : [];
  return found
    .map((p) => ({ id: String(p?.payload?.memory_id ?? ''), score: Number(p?.score ?? 0) }))
    .filter((h) => h.id && h.id !== memoryId);
}
