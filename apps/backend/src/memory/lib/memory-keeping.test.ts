import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { pointId } from '../../engine/lib/corpus-backend.js';
import type { Database } from '../../platform/index.js';
import { consolidateOwner } from './memory-keeping.js';
import type { MemoryItem } from './memory-store.js';

const QUICKWIT = 'http://quickwit.keeping.test:7280';
const QDRANT = 'http://qdrant.keeping.test:6333';
const TEI = 'http://tei.keeping.test';
const ends = { index: { base: QUICKWIT }, vectors: { base: QDRANT, apiKey: 'k' }, embeddings: { base: TEI } };

const NOW = new Date().toISOString();
const daysBefore = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const memory = (id: string, title: string, days: number): MemoryItem => ({
  id, ownerId: 'u1', category: 'environment_facts', scope: 'global', status: 'active', title, text: `${title}, as the person said.`,
  createdAt: daysBefore(days), updatedAt: daysBefore(days),
});

const server = interceptHttp();

let db: Database;

const current = async () => (await db.memory.getMemories('u1')).filter((item) => !item.invalidAt).map((item) => item.id).sort();

const answering = () => {
  const asked: { removed: string[]; embedded: string[]; written: string[] } = { removed: [], embedded: [], written: [] };
  server.use(
    http.post(`${QUICKWIT}/api/v1/:index/delete-tasks`, async ({ request }) => { asked.removed.push(`quickwit ${await request.text()}`); return HttpResponse.json({ opstamp: 1 }); }),
    http.post(`${QDRANT}/collections/:collection/points/delete`, async ({ request }) => { asked.removed.push(`qdrant ${await request.text()}`); return HttpResponse.json({ result: {} }); }),
    http.post(`${QDRANT}/collections/:collection/points/recommend`, async ({ request }) => {
      const { positive } = await request.json() as { positive: string[] };
      return HttpResponse.json({ result: positive[0] === pointId('c') ? [{ payload: { memory_id: 'd' }, score: 0.99 }] : [] });
    }),
    http.post(`${TEI}/embed`, async ({ request }) => HttpResponse.json(((await request.json()) as { inputs: string[] }).inputs.map(() => [0.1, 0.2]))),
    http.put(`${QDRANT}/collections/:collection`, () => HttpResponse.json({ result: true })),
    http.put(`${QDRANT}/collections/:collection/points`, async ({ request }) => {
      asked.embedded.push(...((await request.json()) as { points: { payload: { memory_id: string } }[] }).points.map((point) => point.payload.memory_id));
      return HttpResponse.json({ result: {} });
    }),
    http.post(`${QUICKWIT}/api/v1/indexes`, () => HttpResponse.json({})),
    http.post(`${QUICKWIT}/api/v1/:index/ingest`, async ({ request }) => {
      asked.written.push(...(await request.text()).split('\n').map((line) => (JSON.parse(line) as { memory_id: string }).memory_id));
      return HttpResponse.json({ num_docs_for_processing: 1 });
    }),
  );
  return asked;
};

beforeEach(async () => {
  db = memoryDatabase();
  for (const item of [memory('a', 'DNS lives at Cloudflare', 8), memory('b', 'DNS lives at Cloudflare', 6), memory('c', 'Trials last a week', 4), memory('d', 'Pool trials run seven days', 5)]) {
    await db.memory.saveMemory(item);
  }
});

describe('consolidating one person\'s memories with their own Quickwit, Qdrant and TEI', () => {
  it('retires what has the same title or what their Qdrant finds alike, takes it out of both indexes, and indexes what is left', async () => {
    const asked = answering();

    const report = await consolidateOwner({ db, reach: async () => ends, now: () => NOW }, 'u1');

    expect(report).toMatchObject({ deduped: 2, indexed: 2, live: 2 });
    expect(await current()).toEqual(['b', 'c']);
    expect((await db.memory.getMemories('u1')).filter((item) => item.invalidAt).map((item) => [item.id, item.supersededBy])).toEqual([['a', 'b'], ['d', 'c']]);
    expect(asked.removed).toEqual([
      `quickwit ${JSON.stringify({ query: 'memory_id:"a" OR memory_id:"d"' })}`,
      `qdrant ${JSON.stringify({ points: [pointId('a'), pointId('d')] })}`,
    ]);
    expect(asked.embedded.sort()).toEqual(['b', 'c']);
    expect(asked.written.sort()).toEqual(['b', 'c']);
  });

  it('keeps every memory current when their indexes cannot be reached, since nothing retired could be taken out of them', async () => {
    await expect(consolidateOwner({ db, reach: async () => { throw new Error('the cluster proxy is not answering'); }, now: () => NOW }, 'u1')).rejects.toThrow('the cluster proxy is not answering');

    expect(await current()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('consolidating the memories of a person with no Quickwit, Qdrant or TEI of their own', () => {
  it('still retires what has the same title, and indexes nothing', async () => {
    const report = await consolidateOwner({ db, reach: async () => ({}), now: () => NOW }, 'u1');

    expect(report).toMatchObject({ deduped: 1, indexed: 0, live: 3 });
    expect(await current()).toEqual(['b', 'c', 'd']);
  });
});
