import { describe, it, expect } from 'vitest';
import { toPage, search, receiptFor, MAX_PAGE_CHARS, SNIPPET_CHARS, MAX_HITS } from './corpus.js';
import { buildBatchPayload, readCrawlResults, canonical, usableLinks, rank } from './crawl-client.js';

const page = (url: string, text: string) =>
  toPage({ url, markdown: text }, { id: url, ownerId: 'u1', ingestId: 'i1', now: '2026-01-01T00:00:00Z' });

describe('storing a crawled page', () => {
  it('records where it came from and how much of it there is', () => {
    const p = page('https://docs.temporal.io/workflows', 'Workflows are durable.');
    expect(p).toMatchObject({ url: 'https://docs.temporal.io/workflows', host: 'docs.temporal.io', bytes: 22 });
  });

  it('truncates a pathological page rather than failing the crawl', () => {
    // A document store has its own ceiling, and one enormous page should not be able to fail
    // everything fetched alongside it.
    const p = page('https://example.com/big', 'x'.repeat(MAX_PAGE_CHARS + 5000));
    expect(p.text.length).toBe(MAX_PAGE_CHARS);
    // The receipt describes what is actually stored, not what was fetched.
    expect(p.bytes).toBe(MAX_PAGE_CHARS);
  });

  it('survives a URL it cannot parse', () => {
    expect(page('not a url', 'text').host).toBe('');
  });
});

describe('asking a corpus a question', () => {
  const corpus = [
    page('https://a.example/1', 'Temporal is released under the MIT licence and is self-hostable.'),
    page('https://b.example/2', 'Restate uses the Business Source Licence, converting to Apache 2.0.'),
    page('https://c.example/3', 'Nothing relevant here at all.'),
  ];

  it('returns snippets, never pages', () => {
    /**
     * The point of moving ingestion into a workflow is that bytes stop passing through a context
     * window. Handing a page back at the last step would give that up.
     */
    const hits = search(corpus, 'MIT licence');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toBe('https://a.example/1');
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS + 2);
    expect(hits[0]!.snippet).toContain('MIT licence');
  });

  it('is case-insensitive, because a model does not know the page casing', () => {
    expect(search(corpus, 'business source')).toHaveLength(1);
  });

  it('finds nothing for a term that is absent, rather than everything', () => {
    expect(search(corpus, 'kubernetes')).toEqual([]);
    expect(search(corpus, '   ')).toEqual([]);
  });

  it('returns at most one hit per page', () => {
    // A word appearing ninety times in one document would otherwise fill the budget with a single
    // source and hide every other page that mentions it.
    const repeated = [page('https://a.example/1', 'licence '.repeat(200))];
    expect(search(repeated, 'licence')).toHaveLength(1);
  });

  it('caps how many hits reach a prompt', () => {
    const many = Array.from({ length: 40 }, (_, i) => page(`https://a.example/${i}`, 'the term is here'));
    expect(search(many, 'term')).toHaveLength(MAX_HITS);
  });

  it('treats the query as text, not as a pattern', () => {
    /**
     * The query comes from a model. A regular expression like `(a+)+b` against a megabyte of text
     * is a hang that looks exactly like a slow crawl.
     */
    const withParens = [page('https://a.example/1', 'the config is (a+)+b in the file')];
    expect(search(withParens, '(a+)+b')).toHaveLength(1);
  });
});

describe('what an ingest reports back', () => {
  it('counts pages, bytes and hosts, and admits what failed', () => {
    const r = receiptFor('i1', 'https://docs.temporal.io', [
      page('https://docs.temporal.io/a', 'one'),
      page('https://docs.temporal.io/b', 'two'),
    ], 3);
    expect(r).toMatchObject({ pages: 2, bytes: 6, failed: 3, hosts: ['docs.temporal.io'] });
  });
});

describe('walking a site', () => {
  it('treats a fragment as the same page and a query as a different one', () => {
    /**
     * `#install` and `#usage` are one document, and fetching it twice spends the page budget on
     * nothing. `?page=2` is genuinely another page — dropping it silently truncates paginated sites.
     */
    expect(canonical('https://a.example/docs#install')).toBe(canonical('https://a.example/docs#usage'));
    expect(canonical('https://a.example/docs/')).toBe('https://a.example/docs');
    expect(canonical('https://a.example/list?page=2')).not.toBe(canonical('https://a.example/list'));
  });

  it('refuses anything that is not http', () => {
    // A crawl following mailto: or javascript: links is a crawl spending its budget on nothing.
    for (const bad of ['mailto:x@y.z', 'javascript:alert(1)', 'not a url']) {
      expect(canonical(bad)).toBeUndefined();
    }
  });

  it('never leaves the allowed hosts', () => {
    // Without this a single outbound link turns a documentation crawl into a walk of the web.
    const seen = new Set<string>();
    const links = ['https://a.example/one', 'https://evil.example/two'];
    expect(usableLinks(links, ['a.example'], seen)).toEqual(['https://a.example/one']);
  });

  it('queues a link once however many pages point at it', () => {
    const seen = new Set<string>();
    usableLinks(['https://a.example/x'], ['a.example'], seen);
    expect(usableLinks(['https://a.example/x', 'https://a.example/x#top'], ['a.example'], seen)).toEqual([]);
  });

  it('skips assets, because the cheapest page is the one never requested', () => {
    const seen = new Set<string>();
    const links = ['https://a.example/logo.png', 'https://a.example/app.js', 'https://a.example/guide'];
    expect(usableLinks(links, ['a.example'], seen)).toEqual(['https://a.example/guide']);
  });

  it('puts keyword matches first, so a capped crawl spends its budget on them', () => {
    const urls = ['https://a.example/blog', 'https://a.example/pricing', 'https://a.example/licence-and-pricing'];
    expect(rank(urls, ['pricing', 'licence'])[0]).toBe('https://a.example/licence-and-pricing');
  });

  it('keeps discovery order when given no keywords', () => {
    const urls = ['https://a.example/b', 'https://a.example/a'];
    expect(rank(urls, [])).toEqual(urls);
  });
});

describe('reading a crawl response', () => {
  it('takes the markdown and every link the page carried', () => {
    const pages = readCrawlResults({
      results: [{
        url: 'https://a.example',
        markdown: { raw_markdown: 'hello' },
        links: { internal: [{ href: 'https://a.example/x' }], external: [{ href: 'https://b.example' }] },
      }],
    });
    expect(pages[0]).toMatchObject({ url: 'https://a.example', markdown: 'hello' });
    expect(pages[0]!.links).toEqual(['https://a.example/x', 'https://b.example']);
  });

  it('degrades to nothing rather than throwing on a shape it does not know', () => {
    /**
     * This is a deployed service's response, not a contract we control. Throwing inside a Temporal
     * activity would be retried identically forever.
     */
    expect(readCrawlResults(undefined)).toEqual([]);
    expect(readCrawlResults({ unexpected: true })).toEqual([]);
  });

  it('keeps a failed page as a failure rather than as an empty success', () => {
    const pages = readCrawlResults({ results: [{ url: 'https://a', success: false, error_message: '404' }] });
    expect(pages[0]!.error).toBe('404');
  });

  it('sends the batch as one request', () => {
    expect(buildBatchPayload(['https://a', 'https://b']).urls).toHaveLength(2);
  });
});
