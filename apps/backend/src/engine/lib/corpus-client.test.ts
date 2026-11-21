import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { failureOf } from '../../platform/lib/dependencies.js';
import { intercepted, QDRANT, qdrantAt, QUICKWIT, quickwitAt, unreportedReach } from '../../platform/testing/memory-index.js';
import { ensureCollection, ensureIndex, indexPages, purgeCorpus } from './corpus-client.js';
import type { CorpusDoc } from './corpus-backend.js';

const ends = unreportedReach(intercepted);

const doc: CorpusDoc = {
  url: 'https://docs.example.com/a', host: 'docs.example.com', owner_id: 'u1', ingest_id: 'i1', project_id: '',
  body: 'The retry budget is three attempts per job, and each attempt waits twice as long as the one before it, so a job that keeps failing is given up on after about a minute of trying.',
  fetched_at: '2026-11-17T00:00:00.000Z',
};

const server = interceptHttp();

describe('purging an ingest', () => {
  it('purging an ingest the index refuses fails with Quickwit\'s answer', async () => {
    server.use(
      http.post(`${QUICKWIT}/api/v1/:index/delete-tasks`, () => HttpResponse.text('index koala-corpus is read-only', { status: 403 })),
      http.post(`${QDRANT}/collections/:collection/points/delete`, () => HttpResponse.json({ result: {} })),
    );
    await expect(purgeCorpus(ends, 'i1')).rejects.toThrow('Quickwit refused: HTTP 403 index koala-corpus is read-only');
  });

  it('a purge Qdrant cannot take just now is a failure to try again, not one to give up on', async () => {
    server.use(
      http.post(`${QUICKWIT}/api/v1/:index/delete-tasks`, () => HttpResponse.json({ opstamp: 1 })),
      http.post(`${QDRANT}/collections/:collection/points/delete`, () => HttpResponse.text('overloaded', { status: 503 })),
    );
    const failed = await purgeCorpus(ends, 'i1').then(() => undefined, (err: unknown) => err);
    expect(failureOf(failed)).toEqual({ kind: 'temporary', reason: 'it answered 503' });
  });
});

describe('writing pages to the corpus', () => {
  it('pages Quickwit refuses fail with its answer', async () => {
    server.use(http.post(`${QUICKWIT}/api/v1/:index/ingest`, () => HttpResponse.text('disk full', { status: 507 })));
    await expect(indexPages(ends.index, [doc])).rejects.toThrow('Quickwit refused: HTTP 507 disk full');
  });
});

describe('making the corpus\'s index and collection', () => {
  it('an index Quickwit refuses to make fails with its answer, and is asked again next time', async () => {
    const base = 'http://quickwit-refusing.test:7280';
    let asked = 0;
    server.use(http.post(`${base}/api/v1/indexes`, () => { asked += 1; return HttpResponse.text('invalid index config', { status: 400 }); }));
    await expect(ensureIndex(quickwitAt(base))).rejects.toThrow('Quickwit refused: HTTP 400 invalid index config');
    await expect(ensureIndex(quickwitAt(base))).rejects.toThrow('Quickwit refused: HTTP 400 invalid index config');
    expect(asked).toBe(2);
  });

  it('an index that is already there is taken as made, and not asked for again', async () => {
    const base = 'http://quickwit-made.test:7280';
    let asked = 0;
    server.use(http.post(`${base}/api/v1/indexes`, () => { asked += 1; return HttpResponse.text('index `koala-corpus` already exists', { status: 400 }); }));
    await ensureIndex(quickwitAt(base));
    await ensureIndex(quickwitAt(base));
    expect(asked).toBe(1);
  });

  it('a collection Qdrant refuses to make fails with its answer', async () => {
    const base = 'http://qdrant-refusing.test:6333';
    server.use(http.put(`${base}/collections/:collection`, () => HttpResponse.text('wrong api key', { status: 401 })));
    await expect(ensureCollection(qdrantAt(base))).rejects.toThrow('Qdrant refused: HTTP 401 wrong api key');
  });

  it('a collection that is already there is taken as made', async () => {
    const base = 'http://qdrant-made.test:6333';
    server.use(http.put(`${base}/collections/:collection`, () => HttpResponse.text('Collection `koala-corpus` already exists!', { status: 409 })));
    await expect(ensureCollection(qdrantAt(base))).resolves.toBeUndefined();
  });
});
