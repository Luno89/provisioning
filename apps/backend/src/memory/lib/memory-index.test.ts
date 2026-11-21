import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { ensureMemoryCollection, ensureMemoryIndex, indexMemories, removeMemories, searchMemories, similarTo } from './memory-index.js';
import { pointId } from '../../engine/lib/corpus-backend.js';
import { recallMemories } from './memory-recall.js';
import type { MemoryItem } from './memory-store.js';

const QUICKWIT = 'http://quickwit.test:7280';
const QDRANT = 'http://qdrant.test:6333';
const TEI = 'http://tei.test';

const ends = { index: { base: QUICKWIT }, vectors: { base: QDRANT, apiKey: 'k' }, embeddings: { base: TEI } };

const memory: MemoryItem = {
  id: 'm1', ownerId: 'u1', category: 'lessons_learned', scope: 'global', title: 'A lesson', text: 'Something learned.',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
};

const server = interceptHttp();

describe('taking memories out of the index', () => {
  it('a memory the index refuses to delete fails with Qdrant\'s answer', async () => {
    server.use(
      http.post(`${QUICKWIT}/api/v1/:index/delete-tasks`, () => HttpResponse.json({ opstamp: 1 })),
      http.post(`${QDRANT}/collections/:collection/points/delete`, () => HttpResponse.text('collection is read-only', { status: 403 })),
    );
    await expect(removeMemories(ends, ['m1'])).rejects.toThrow('Qdrant refused: HTTP 403 collection is read-only');
  });

  it('a memory Quickwit refuses to delete fails with Quickwit\'s answer', async () => {
    server.use(
      http.post(`${QUICKWIT}/api/v1/:index/delete-tasks`, () => HttpResponse.text('index not found', { status: 404 })),
      http.post(`${QDRANT}/collections/:collection/points/delete`, () => HttpResponse.json({ result: {} })),
    );
    await expect(removeMemories(ends, ['m1'])).rejects.toThrow('Quickwit refused: HTTP 404 index not found');
  });
});

describe('putting memories in the index', () => {
  it('memories the index refuses fail with Quickwit\'s answer rather than being left out quietly', async () => {
    server.use(
      http.post(`${TEI}/embed`, () => HttpResponse.json([[0.1, 0.2]])),
      http.put(`${QDRANT}/collections/:collection`, () => HttpResponse.json({ result: true })),
      http.put(`${QDRANT}/collections/:collection/points`, () => HttpResponse.json({ result: {} })),
      http.post(`${QUICKWIT}/api/v1/indexes`, () => HttpResponse.json({})),
      http.post(`${QUICKWIT}/api/v1/:index/ingest`, () => HttpResponse.text('disk full', { status: 507 })),
    );
    await expect(indexMemories(ends, [memory])).rejects.toThrow('Quickwit refused: HTTP 507 disk full');
  });
});

describe('searching memories', () => {
  it('a search Qdrant cannot answer fails rather than finding nothing', async () => {
    server.use(
      http.post(`${TEI}/embed`, () => HttpResponse.json([[0.1, 0.2]])),
      http.post(`${QDRANT}/collections/:collection/points/search`, () => HttpResponse.text('overloaded', { status: 503 })),
      http.get(`${QUICKWIT}/api/v1/:index/search`, () => HttpResponse.json({ hits: [{ memory_id: 'm1' }] })),
    );
    await expect(searchMemories(ends, 'lesson', { ownerId: 'u1' })).rejects.toThrow('Qdrant refused: HTTP 503 overloaded');
  });
});

describe('making the memories\' index and collection', () => {
  it('an index Quickwit refuses to make fails with its answer', async () => {
    const base = 'http://quickwit-refusing.test:7280';
    server.use(http.post(`${base}/api/v1/indexes`, () => HttpResponse.text('invalid index config', { status: 400 })));
    await expect(ensureMemoryIndex(base)).rejects.toThrow('Quickwit refused: HTTP 400 invalid index config');
  });

  it('a collection Qdrant refuses to make fails with its answer', async () => {
    const base = 'http://qdrant-refusing.test:6333';
    server.use(http.put(`${base}/collections/:collection`, () => HttpResponse.text('wrong api key', { status: 401 })));
    await expect(ensureMemoryCollection(base, 'k')).rejects.toThrow('Qdrant refused: HTTP 401 wrong api key');
  });
});

describe('finding memories like one', () => {
  it('names the person\'s other memories Qdrant finds like it, with how alike they are, and never the memory itself', async () => {
    let asked: unknown;
    server.use(http.post(`${QDRANT}/collections/:collection/points/recommend`, async ({ request }) => {
      asked = await request.json();
      return HttpResponse.json({ result: [
        { payload: { memory_id: 'm1' }, score: 1 },
        { payload: { memory_id: 'm2' }, score: 0.98 },
        { payload: { memory_id: 'm3' }, score: 0.5 },
      ] });
    }));

    expect(await similarTo(ends, 'm1', { ownerId: 'u1' })).toEqual([{ id: 'm2', score: 0.98 }, { id: 'm3', score: 0.5 }]);
    expect(asked).toMatchObject({ positive: [pointId('m1')], filter: { must: [{ key: 'owner_id', match: { value: 'u1' } }] } });
  });

  it('a comparison Qdrant cannot answer fails with its answer rather than finding nothing alike', async () => {
    server.use(http.post(`${QDRANT}/collections/:collection/points/recommend`, () => HttpResponse.text('overloaded', { status: 503 })));
    await expect(similarTo(ends, 'm1', { ownerId: 'u1' })).rejects.toThrow('Qdrant refused: HTTP 503 overloaded');
  });
});

describe('recalling memories for a run through the person\'s own search', () => {
  const bank: MemoryItem[] = [
    { ...memory, id: 'newest', title: 'NEWEST', createdAt: '2026-08-20T00:00:00.000Z' },
    { ...memory, id: 'relevant', title: 'RELEVANT', createdAt: '2026-01-01T00:00:00.000Z' },
  ];

  it('puts what their Qdrant and Quickwit both rank ahead of what is merely recent', async () => {
    server.use(
      http.post(`${TEI}/embed`, () => HttpResponse.json([[0.1, 0.2]])),
      http.post(`${QDRANT}/collections/:collection/points/search`, () => HttpResponse.json({ result: [{ payload: { memory_id: 'relevant' } }] })),
      http.get(`${QUICKWIT}/api/v1/:index/search`, () => HttpResponse.json({ hits: [{ memory_id: 'relevant' }] })),
    );

    const out = await recallMemories({ memories: bank, ownerId: 'u1', query: 'rate limiting', endpoints: async () => ends });

    expect(out.via).toBe('hybrid');
    expect(out.context.indexOf('RELEVANT')).toBeLessThan(out.context.indexOf('NEWEST'));
  });

  it('fails, saying Quickwit\'s answer, when their Quickwit cannot search', async () => {
    server.use(
      http.post(`${TEI}/embed`, () => HttpResponse.json([[0.1, 0.2]])),
      http.post(`${QDRANT}/collections/:collection/points/search`, () => HttpResponse.json({ result: [] })),
      http.get(`${QUICKWIT}/api/v1/:index/search`, () => HttpResponse.text('index not found', { status: 404 })),
    );

    await expect(recallMemories({ memories: bank, ownerId: 'u1', query: 'rate limiting', endpoints: async () => ends })).rejects.toThrow('memories could not be searched: Quickwit refused: HTTP 404 index not found');
  });
});
