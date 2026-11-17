import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../platform/testing/http.js';
import type { DependencyReporter, HostWorkerSettings } from '../platform/index.js';
import type { ClusterAccess } from '../infrastructure/index.js';
import { crawlPages } from '../engine/lib/crawl-client.js';
import { crawlPlaceFor } from './CrawlActivity.js';

const CRAWL4AI = 'http://crawl4ai.instance.test:11235';

const placeWith = (webTools: HostWorkerSettings['webTools']) =>
  crawlPlaceFor({ webTools } as HostWorkerSettings, mock<ClusterAccess>(), mock<DependencyReporter>());

const server = interceptHttp();

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
