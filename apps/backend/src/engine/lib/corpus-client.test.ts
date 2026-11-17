import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { failureOf } from '../../platform/lib/dependencies.js';
import { embedPages, indexPages, purgeCorpus } from './corpus-client.js';
import type { CorpusDoc } from './corpus-backend.js';

const QUICKWIT = 'http://quickwit.test:7280';
const QDRANT = 'http://qdrant.test:6333';
const TEI = 'http://tei.test';

const ends = { index: { base: QUICKWIT }, vectors: { base: QDRANT, apiKey: 'k' }, embeddings: { base: TEI } };

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

  it('a person with no Qdrant of their own is told so, and nothing is asked', async () => {
    await expect(purgeCorpus({ index: { base: QUICKWIT } }, 'i1')).rejects.toThrow('purging a crawl needs your own Quickwit and Qdrant running, and you have no running Qdrant: deploy it as an app first');
  });
});

describe('writing pages to the corpus', () => {
  it('pages Quickwit refuses fail with its answer', async () => {
    server.use(http.post(`${QUICKWIT}/api/v1/:index/ingest`, () => HttpResponse.text('disk full', { status: 507 })));
    await expect(indexPages(QUICKWIT, [doc])).rejects.toThrow('Quickwit refused: HTTP 507 disk full');
  });

  it('pages with no TEI to embed them are refused, naming it, rather than left unembedded', async () => {
    await expect(embedPages({ vectors: { base: QDRANT, apiKey: 'k' } }, [doc])).rejects.toThrow('you have no running TEI');
  });
});
