import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { http, HttpResponse } from 'msw';
import { ApplicationFailure } from '@temporalio/common';
import { interceptHttp } from '../platform/testing/http.js';
import { containing } from '../platform/lib/test-matchers.js';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import type { DependencyReporter, HostWorkerSettings } from '../platform/index.js';
import type { ClusterAccess } from '../infrastructure/index.js';
import type { CorpusEndpoints } from '../engine/index.js';
import { crawlPages } from '../engine/lib/crawl-client.js';
import { giveHostActivities } from './host-settings.js';
import { records } from './testing/recorded-database.js';
import { crawlActivities, crawlPlaceFor, DiscardFrontierActivity, NextBatchActivity, PurgeCorpusActivity, SeedFrontierActivity } from './CrawlActivity.js';

vi.mock('../platform/index.js', async (actual) => (await import('./testing/recorded-database.js')).withRecordedDatabase(await actual<typeof import('../platform/index.js')>()));

const CRAWL4AI = 'http://crawl4ai.instance.test:11235';
const PAGE = 'The retry budget is three attempts per job, and each attempt waits twice as long as the one before it, so a job that keeps failing is given up on after about a minute of trying again.';

const settingsWith = (webTools: HostWorkerSettings['webTools']) =>
  ({ webTools, mongo: { uri: 'mongodb://unused', dbName: 'unused' }, keys: { data: 'crawl-test-key' } }) as unknown as HostWorkerSettings;

const placeWith = (webTools: HostWorkerSettings['webTools']) =>
  crawlPlaceFor(settingsWith(webTools), mock<ClusterAccess>(), mock<DependencyReporter>());

const server = interceptHttp();

let stores = 0;
const ownStores = (): Required<Pick<CorpusEndpoints, 'index' | 'vectors' | 'embeddings'>> => {
  stores += 1;
  return { index: { base: `http://quickwit-${stores}.test:7280` }, vectors: { base: `http://qdrant-${stores}.test:6333`, apiKey: 'k' }, embeddings: { base: `http://tei-${stores}.test` } };
};

const crawlingWith = (ends: CorpusEndpoints) => crawlActivities(() => ({ ...placeWith({ crawl4aiUrl: CRAWL4AI, crawl4aiToken: 'instance-token' }), endpoints: async () => ends }));

const answering = (ends: ReturnType<typeof ownStores>, ingest: () => Response | Promise<Response> = () => HttpResponse.json({ num_docs_for_processing: 1 })) => {
  const indexed: string[] = [];
  const embedded: unknown[] = [];
  server.use(
    http.post(`${CRAWL4AI}/crawl`, () => HttpResponse.json({ results: [{ url: 'https://docs.example.com/', success: true, markdown: PAGE, links: { internal: [{ href: 'https://docs.example.com/next' }, { href: 'https://elsewhere.example.org/' }], external: [] } }] })),
    http.post(`${ends.index.base}/api/v1/indexes`, () => HttpResponse.json({})),
    http.post(`${ends.index.base}/api/v1/:index/ingest`, async ({ request }) => { indexed.push(await request.text()); return ingest(); }),
    http.put(`${ends.vectors.base}/collections/:collection`, () => HttpResponse.json({ result: true })),
    http.put(`${ends.vectors.base}/collections/:collection/points`, async ({ request }) => { embedded.push(await request.json()); return HttpResponse.json({ result: {} }); }),
    http.post(`${ends.embeddings.base}/embed`, async ({ request }) => HttpResponse.json(((await request.json()) as { inputs: string[] }).inputs.map(() => [0.1, 0.2]))),
  );
  return { indexed, embedded };
};

const batch = (ingestId: string) => ({ ownerId: 'u1', ingestId, batch: [{ url: 'https://docs.example.com/', depth: 0 }], allowed: ['docs.example.com'], keywords: [], maxDepth: 1 });

const failureOfCrawl = (run: Promise<unknown>) => run.then(() => undefined, (err: unknown) => err);

beforeEach(() => {
  records.db = memoryDatabase();
});

describe('the crawler a crawl uses', () => {
  it('is the instance\'s own Crawl4AI, at its settings\' address and with its token', async () => {
    let asked: { url: string; authorization: string | null } | undefined;
    server.use(http.post(`${CRAWL4AI}/crawl`, ({ request }) => {
      asked = { url: request.url, authorization: request.headers.get('authorization') };
      return HttpResponse.json({ results: [{ url: 'https://docs.example.com/', success: true, markdown: 'Docs.' }] });
    }));

    const crawler = placeWith({ crawl4aiUrl: CRAWL4AI, crawl4aiToken: 'instance-token' }).crawler();
    const pages = await crawlPages(crawler, ['https://docs.example.com/']);

    expect(asked).toEqual({ url: `${CRAWL4AI}/crawl`, authorization: 'Bearer instance-token' });
    expect(pages.map((page) => page.markdown)).toEqual(['Docs.']);
  });

  it('is refused, saying which settings are missing, where the instance has no Crawl4AI set', () => {
    expect(() => placeWith({}).crawler()).toThrow('this Koala has no Crawl4AI of its own set (CRAWL4AI_URL and CRAWL4AI_API_TOKEN), so nothing can be crawled');
  });

  it('a Crawl4AI that refuses the batch fails with its answer', async () => {
    server.use(http.post(`${CRAWL4AI}/crawl`, () => HttpResponse.text('bad token', { status: 401 })));
    await expect(crawlPages(placeWith({ crawl4aiUrl: CRAWL4AI, crawl4aiToken: 'wrong' }).crawler(), ['https://docs.example.com/'])).rejects.toThrow('Crawl4AI refused: HTTP 401 bad token');
  });
});

describe('crawling a batch into a person\'s corpus', () => {
  it('keeps each page in the person\'s index, vectors and database, and queues the links on the sites they allowed', async () => {
    const ends = ownStores();
    const { indexed, embedded } = answering(ends);

    const result = await crawlingWith(ends).CrawlBatchActivity(batch('i1'));

    expect(result).toEqual({ stored: 1, bytes: PAGE.length, failed: 0, queued: 1, hosts: ['docs.example.com'] });
    expect(indexed.join('\n')).toContain('"url":"https://docs.example.com/"');
    expect(embedded).toHaveLength(1);
    expect((await records.db!.engine.getCorpusPages({ ownerId: 'u1', ingestId: 'i1' })).map((page) => page.url)).toEqual(['https://docs.example.com/']);
    expect(await records.db!.engine.claimFrontier('i1', 8)).toEqual([{ url: 'https://docs.example.com/next', depth: 1 }]);
  });

  it('a page the index refuses for good fails the batch for good, saying the index\'s answer, and nothing is kept', async () => {
    const ends = ownStores();
    answering(ends, () => HttpResponse.text('document is malformed', { status: 400 }));

    const failed = await failureOfCrawl(crawlingWith(ends).CrawlBatchActivity(batch('i2')));

    expect(failed).toBeInstanceOf(ApplicationFailure);
    expect(failed).toMatchObject({ nonRetryable: true, type: 'CorpusRefused', message: containing('Quickwit refused: HTTP 400 document is malformed') });
    expect(await records.db!.engine.getCorpusPages({ ownerId: 'u1', ingestId: 'i2' })).toEqual([]);
  });

  it('an index that cannot take the pages just now fails the batch so it is tried again', async () => {
    const ends = ownStores();
    answering(ends, () => HttpResponse.text('overloaded', { status: 503 }));

    const failed = await failureOfCrawl(crawlingWith(ends).CrawlBatchActivity(batch('i3')));

    expect(failed).toBeInstanceOf(Error);
    expect(failed instanceof ApplicationFailure && failed.nonRetryable).toBe(false);
    expect(await records.db!.engine.getCorpusPages({ ownerId: 'u1', ingestId: 'i3' })).toEqual([]);
  });

  it('a person with no Quickwit, Qdrant or TEI of their own is refused for good, naming them', async () => {
    const failed = await failureOfCrawl(crawlingWith({}).CrawlBatchActivity(batch('i4')));

    expect(failed).toMatchObject({ nonRetryable: true, type: 'CorpusStoresMissing', message: 'crawling a site into your corpus needs your own Quickwit, Qdrant and TEI running, and you have no running Quickwit, Qdrant and TEI: deploy it as an app first' });
  });
});

describe('ending and purging a crawl', () => {
  it('a crawl\'s frontier that is discarded hands out nothing more', async () => {
    const crawling = crawlingWith({});
    await crawling.SeedFrontierActivity({ ingestId: 'i5', seed: 'https://docs.example.com/', keywords: [] });

    await crawling.DiscardFrontierActivity({ ingestId: 'i5' });

    expect(await crawling.NextBatchActivity({ ingestId: 'i5', limit: 8 })).toEqual({ batch: [], remaining: 0 });
  });

  it('a purged crawl leaves the person\'s index, vectors and database', async () => {
    const ends = ownStores();
    const asked: string[] = [];
    server.use(
      http.post(`${ends.index.base}/api/v1/:index/delete-tasks`, async ({ request }) => { asked.push(`quickwit ${await request.text()}`); return HttpResponse.json({ opstamp: 1 }); }),
      http.post(`${ends.vectors.base}/collections/:collection/points/delete`, async ({ request }) => { asked.push(`qdrant ${await request.text()}`); return HttpResponse.json({ result: {} }); }),
    );
    await records.db!.engine.saveCorpusPages([{ id: 'i6:https://docs.example.com/', ownerId: 'u1', ingestId: 'i6', url: 'https://docs.example.com/', host: 'docs.example.com', text: PAGE, bytes: PAGE.length, fetchedAt: '2026-11-18T00:00:00.000Z' }]);

    await crawlingWith(ends).PurgeCorpusActivity({ ownerId: 'u1', ingestId: 'i6' });

    expect(asked).toEqual([
      `quickwit ${JSON.stringify({ query: 'ingest_id:"i6"' })}`,
      `qdrant ${JSON.stringify({ filter: { must: [{ key: 'ingest_id', match: { value: 'i6' } }] } })}`,
    ]);
    expect(await records.db!.engine.getCorpusPages({ ownerId: 'u1', ingestId: 'i6' })).toEqual([]);
  });

  it('a purge the index refuses for good fails for good, and the pages are kept', async () => {
    const ends = ownStores();
    server.use(
      http.post(`${ends.index.base}/api/v1/:index/delete-tasks`, () => HttpResponse.text('index is read-only', { status: 403 })),
      http.post(`${ends.vectors.base}/collections/:collection/points/delete`, () => HttpResponse.json({ result: {} })),
    );
    await records.db!.engine.saveCorpusPages([{ id: 'i7:https://docs.example.com/', ownerId: 'u1', ingestId: 'i7', url: 'https://docs.example.com/', host: 'docs.example.com', text: PAGE, bytes: PAGE.length, fetchedAt: '2026-11-18T00:00:00.000Z' }]);

    const failed = await failureOfCrawl(crawlingWith(ends).PurgeCorpusActivity({ ownerId: 'u1', ingestId: 'i7' }));

    expect(failed).toMatchObject({ nonRetryable: true, type: 'CorpusRefused' });
    expect(await records.db!.engine.getCorpusPages({ ownerId: 'u1', ingestId: 'i7' })).toHaveLength(1);
  });
});

describe('the crawl activities the host worker registers', () => {
  it('work on the database the host worker\'s settings name, once the worker has given them', async () => {
    giveHostActivities(settingsWith({}), mock<ClusterAccess>(), mock<DependencyReporter>());
    await records.db!.engine.saveCorpusPages([{ id: 'h1:https://docs.example.com/', ownerId: 'u1', ingestId: 'h1', url: 'https://docs.example.com/', host: 'docs.example.com', text: PAGE, bytes: PAGE.length, fetchedAt: '2026-11-18T00:00:00.000Z' }]);

    expect(await SeedFrontierActivity({ ingestId: 'h2', seed: 'https://docs.example.com/', keywords: [] })).toEqual({ queued: 1 });
    await DiscardFrontierActivity({ ingestId: 'h2' });
    expect(await NextBatchActivity({ ingestId: 'h2', limit: 8 })).toEqual({ batch: [], remaining: 0 });
    await PurgeCorpusActivity({ ownerId: 'u1', ingestId: 'h1' });
    expect(await records.db!.engine.getCorpusPages({ ownerId: 'u1', ingestId: 'h1' })).toEqual([]);
  });
});
