import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { indexMemories, removeMemories, searchMemories } from './memory-index.js';
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

  it('a person with no Quickwit or Qdrant of their own has nothing in an index, so forgetting goes ahead and nothing is asked', async () => {
    await expect(removeMemories({}, ['m1'])).resolves.toBeUndefined();
  });

  it('a person with only Quickwit has the memory taken out of Quickwit, and Qdrant, which they do not have, is not asked', async () => {
    const asked: string[] = [];
    server.use(http.post(`${QUICKWIT}/api/v1/:index/delete-tasks`, async ({ request }) => { asked.push(await request.text()); return HttpResponse.json({ opstamp: 1 }); }));
    await removeMemories({ index: { base: QUICKWIT } }, ['m1']);
    expect(asked).toEqual([JSON.stringify({ query: 'memory_id:"m1"' })]);
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

  it('memories with no TEI to embed them are refused, naming it', async () => {
    await expect(indexMemories({ index: { base: QUICKWIT }, vectors: { base: QDRANT, apiKey: 'k' } }, [memory])).rejects.toThrow('you have no running TEI');
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
