import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { intercepted as settings, QDRANT, qdrantAt, QUICKWIT, quickwitAt, TEI, unreportedReach } from '../../platform/testing/memory-index.js';
import { DependencyStates } from '../../platform/services/DependencyStates.js';
import { DependencyDownError, MEMORY_INDEX_DEPENDENCIES, reachingMemoryIndex } from '../../platform/lib/dependencies.js';
import { dependencyFetch } from '@koala/engine-core/http';
import { ensureMemoryCollection, ensureMemoryIndex, indexMemories, removeMemories, searchMemories, searcherFrom, similarTo } from './memory-index.js';
import { pointId } from '../../engine/lib/corpus-backend.js';
import type { MemoryItem } from './memory-store.js';

const ends = unreportedReach(settings);

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
    await expect(ensureMemoryIndex(quickwitAt(base))).rejects.toThrow('Quickwit refused: HTTP 400 invalid index config');
  });

  it('a collection Qdrant refuses to make fails with its answer', async () => {
    const base = 'http://qdrant-refusing.test:6333';
    server.use(http.put(`${base}/collections/:collection`, () => HttpResponse.text('wrong api key', { status: 401 })));
    await expect(ensureMemoryCollection(qdrantAt(base))).rejects.toThrow('Qdrant refused: HTTP 401 wrong api key');
  });
});

describe('the index reporting to its dependencies', () => {
  const watching = (doFetch: typeof fetch = dependencyFetch) => {
    const states = new DependencyStates({ process: 'worker-engine', described: MEMORY_INDEX_DEPENDENCIES, now: () => new Date('2026-11-21T10:00:00.000Z'), log: () => undefined });
    return { states, reach: reachingMemoryIndex(settings, states, doFetch) };
  };
  const refusedAt = (base: string): typeof fetch => (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).startsWith(base)) throw new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ECONNREFUSED ${base}`), { code: 'ECONNREFUSED' }) });
    return dependencyFetch(input, init);
  }) as typeof fetch;

  it('a Qdrant that cannot answer just now is shown down with since and why, and the search says so', async () => {
    server.use(
      http.post(`${TEI}/embed`, () => HttpResponse.json([[0.1, 0.2]])),
      http.post(`${QDRANT}/collections/:collection/points/search`, () => HttpResponse.text('overloaded', { status: 503 })),
      http.get(`${QUICKWIT}/api/v1/:index/search`, () => HttpResponse.json({ hits: [] })),
    );
    const { states, reach } = watching();
    const failed = await searchMemories(reach, 'lesson', { ownerId: 'u1' }).then(() => undefined, (err: unknown) => err);
    states.stop();
    expect(failed).toBeInstanceOf(DependencyDownError);
    expect(failed).toMatchObject({ dependency: 'qdrant', since: '2026-11-21T10:00:00.000Z' });
    expect(states.down().map((down) => down.dependency)).toEqual(['qdrant']);
  });

  it('a TEI nothing answers at is shown down, and the search says so', async () => {
    server.use(http.get(`${QUICKWIT}/api/v1/:index/search`, () => HttpResponse.json({ hits: [] })));
    const { states, reach } = watching(refusedAt(TEI));
    const failed = await searchMemories(reach, 'lesson', { ownerId: 'u1' }).then(() => undefined, (err: unknown) => err);
    states.stop();
    expect(failed).toMatchObject({ dependency: 'tei' });
    expect(states.down().map((down) => down.dependency)).toEqual(['tei']);
  });

  it('a Qdrant that refuses for good is not shown down, and its answer is kept', async () => {
    server.use(http.post(`${QDRANT}/collections/:collection/points/recommend`, () => HttpResponse.text('wrong api key', { status: 401 })));
    const { states, reach } = watching();
    await expect(similarTo(reach, 'm1', { ownerId: 'u1' })).rejects.toThrow('Qdrant refused: HTTP 401 wrong api key');
    states.stop();
    expect(states.down()).toEqual([]);
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
  const fresh = unreportedReach({ index: { base: 'http://quickwit-fresh.test:7280' }, vectors: { base: 'http://qdrant-fresh.test:6333', apiKey: 'k' }, embeddings: { base: TEI } });

  it('puts first what Qdrant and Quickwit both find, asking each for as many as it is told', async () => {
    const limits: unknown[] = [];
    server.use(
      http.post(`${QUICKWIT}/api/v1/indexes`, () => HttpResponse.json({})),
      http.put(`${QDRANT}/collections/:collection`, () => HttpResponse.json({ result: true })),
      http.post(`${TEI}/embed`, () => HttpResponse.json([[0.1, 0.2]])),
      http.post(`${QDRANT}/collections/:collection/points/search`, async ({ request }) => {
        limits.push(((await request.json()) as { limit: unknown }).limit);
        return HttpResponse.json({ result: [{ payload: { memory_id: 'a' } }, { payload: { memory_id: 'b' } }] });
      }),
      http.get(`${QUICKWIT}/api/v1/:index/search`, ({ request }) => {
        limits.push(new URL(request.url).searchParams.get('max_hits'));
        return HttpResponse.json({ hits: [{ memory_id: 'b' }] });
      }),
    );

    expect(await searcherFrom(ends)('u1', 'rate limiting', 7)).toEqual(['b', 'a']);
    expect(limits.map(String)).toEqual(['7', '7']);
  });

  it('asks the index nothing for a person with no memories', async () => {
    expect(await searcherFrom(ends)('u1', 'rate limiting', 0)).toEqual([]);
  });

  it('makes the memories\' index and collection before its first search, so a new Koala finds nothing rather than failing', async () => {
    const made: string[] = [];
    server.use(
      http.post('http://quickwit-fresh.test:7280/api/v1/indexes', () => { made.push('index'); return HttpResponse.json({}); }),
      http.put('http://qdrant-fresh.test:6333/collections/:collection', () => { made.push('collection'); return HttpResponse.json({ result: true }); }),
      http.post(`${TEI}/embed`, () => HttpResponse.json([[0.1, 0.2]])),
      http.post('http://qdrant-fresh.test:6333/collections/:collection/points/search', () => HttpResponse.json({ result: [] })),
      http.get('http://quickwit-fresh.test:7280/api/v1/:index/search', () => HttpResponse.json({ hits: [] })),
    );

    expect(await searcherFrom(fresh)('u1', 'rate limiting', 3)).toEqual([]);
    expect(made.sort()).toEqual(['collection', 'index']);
  });
});
