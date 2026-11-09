import { describe, it, expect, vi } from 'vitest';
import { createWebTools, renderSearchOutcome } from './web-tools.js';

function stubFetch(routes: Array<[string, Partial<Response> | (() => Partial<Response>)]>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [match, res] of routes) {
      if (url.includes(match)) {
        const r = typeof res === 'function' ? res() : res;
        return { ok: true, status: 200, json: async () => ({}), text: async () => '', ...r } as Response;
      }
    }
    throw new Error(`unrouted: ${url}`);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('search', () => {
  it('asks SearXNG', async () => {
    const { impl, calls } = stubFetch([
      ['searx', { json: async () => ({ results: [{ title: 'T', content: 'S', url: 'https://x.dev' }] }) }],
    ]);
    const tools = createWebTools({ searxngUrl: 'http://searx:8080', fetchImpl: impl });

    expect(await tools.search('kubernetes')).toEqual({ hits: [{ title: 'T', snippet: 'S', url: 'https://x.dev' }], unavailable: false });
    expect(calls[0]?.url).toContain('format=json');
  });

  it('says search is unavailable, and why, when SearXNG cannot be reached, and asks nothing else', async () => {
    const { impl, calls } = stubFetch([['searx', () => { throw new Error('Searxng isn\'t answering since 10:02 UTC: it refused the connection (ECONNREFUSED)'); }]]);
    const tools = createWebTools({ searxngUrl: 'http://searx:8080', fetchImpl: impl });

    expect(await tools.search('kubernetes')).toEqual({ hits: [], unavailable: true, reason: 'Searxng isn\'t answering since 10:02 UTC: it refused the connection (ECONNREFUSED)' });
    expect(calls).toHaveLength(1);
  });

  it('takes an answer with no results as no matches, not as search being down', async () => {
    const { impl, calls } = stubFetch([['searx', { json: async () => ({ results: [] }) }]]);
    const tools = createWebTools({ searxngUrl: 'http://searx:8080', fetchImpl: impl });

    expect(await tools.search('asdkjhasd')).toEqual({ hits: [], unavailable: false });
    expect(calls).toHaveLength(1);
  });

  it('says what was wrong when SearXNG answers with an error or a shape it should not', async () => {
    const tools = (routes: Parameters<typeof stubFetch>[0]) => createWebTools({ searxngUrl: 'http://searx:8080', fetchImpl: stubFetch(routes).impl });
    expect(await tools([['searx', { ok: false, status: 502 }]]).search('x')).toEqual({ hits: [], unavailable: true, reason: 'SearXNG answered 502' });
    expect(await tools([['searx', { json: async () => { throw new Error('not json'); } }]]).search('x')).toEqual({ hits: [], unavailable: true, reason: 'SearXNG\'s its answer could not be read: not json' });
    expect(await tools([['searx', { json: async () => ({ answers: [] }) }]]).search('x')).toEqual({ hits: [], unavailable: true, reason: 'SearXNG answered without a list of results' });
  });

  it('says search is unavailable where no SearXNG is set up, asking nothing', async () => {
    const { impl, calls } = stubFetch([]);
    expect(await createWebTools({ fetchImpl: impl }).search('x')).toEqual({ hits: [], unavailable: true, reason: 'no SearXNG is set up for this Koala' });
    expect(calls).toEqual([]);
  });

  it('puts why search is down into what the model is shown', () => {
    expect(renderSearchOutcome('x', { hits: [], unavailable: true, reason: 'SearXNG answered 502' })).toMatchObject({ unavailable: true, error: 'Search is unavailable: SearXNG answered 502' });
  });
});

describe('fetching a page', () => {
  const crawlOk = (markdown: string) => stubFetch([
    ['/md', { json: async () => ({ markdown, success: true }) }],
  ]);

  it('sends the api_token straight through as a bearer', async () => {
    const { impl, calls } = crawlOk('# Air quality\n\nAQI 42');
    const tools = createWebTools({ crawl4aiUrl: 'http://c4:11235', crawl4aiToken: 'sekrit', fetchImpl: impl });

    expect(await tools.fetchPage('https://weather.com/x')).toContain('AQI 42');
    expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer sekrit');
  });

  it('never calls the token endpoint', async () => {
    const { impl, calls } = crawlOk('page');
    const tools = createWebTools({ crawl4aiUrl: 'http://c4:11235', crawl4aiToken: 's', fetchImpl: impl });

    await tools.fetchPage('https://a.dev');
    expect(calls.some((c) => c.url.includes('/token'))).toBe(false);
  });

  it('says why a page could not be read when Crawl4AI cannot be reached, never fetching the page itself', async () => {
    const { impl, calls } = stubFetch([['/md', () => { throw new Error('Crawl4AI isn\'t answering since 10:02 UTC: it refused the connection (ECONNREFUSED)'); }]]);
    const tools = createWebTools({ crawl4aiUrl: 'http://c4:11235', crawl4aiToken: 's', fetchImpl: impl });

    expect(await tools.readPage('https://example.com')).toEqual({ ok: false, text: 'The page could not be read: Crawl4AI isn\'t answering since 10:02 UTC: it refused the connection (ECONNREFUSED)' });
    expect(calls.map((call) => call.url)).toEqual(['http://c4:11235/md']);
  });

  it('says so when Crawl4AI answers with an error, finds no text, or answers what cannot be read', async () => {
    const tools = (routes: Parameters<typeof stubFetch>[0]) => createWebTools({ crawl4aiUrl: 'http://c4:11235', crawl4aiToken: 's', fetchImpl: stubFetch(routes).impl });
    expect(await tools([['/md', { ok: false, status: 500 }]]).readPage('https://example.com')).toEqual({ ok: false, text: 'The page could not be read: Crawl4AI answered 500' });
    expect(await tools([['/md', { json: async () => ({ markdown: '   ' }) }]]).readPage('https://example.com')).toEqual({ ok: false, text: 'The page could not be read: Crawl4AI found no text on it' });
    expect(await tools([['/md', { json: async () => { throw new Error('terminated'); } }]]).readPage('https://example.com')).toEqual({ ok: false, text: 'The page could not be read: Crawl4AI\'s its answer could not be read: terminated' });
  });

  it('says pages cannot be read where no Crawl4AI is set up, or it has no token, fetching nothing', async () => {
    const { impl, calls } = stubFetch([]);
    expect(await createWebTools({ fetchImpl: impl }).readPage('https://example.com')).toEqual({ ok: false, text: 'Pages cannot be read: no Crawl4AI is set up for this Koala' });
    expect(await createWebTools({ crawl4aiUrl: 'http://c4:11235', fetchImpl: impl }).readPage('https://example.com')).toEqual({ ok: false, text: 'Pages cannot be read: no Crawl4AI is set up for this Koala' });
    expect(calls).toEqual([]);
  });

  it('refuses a non-http URL before making any request', async () => {
    const { impl, calls } = stubFetch([]);
    const tools = createWebTools({ crawl4aiUrl: 'http://c4:11235', crawl4aiToken: 's', fetchImpl: impl });

    expect(await tools.fetchPage('file:///etc/passwd')).toMatch(/http/);
    expect(calls).toHaveLength(0);
  });

  it('truncates a long page', async () => {
    const { impl } = crawlOk('x'.repeat(50_000));
    const tools = createWebTools({ crawl4aiUrl: 'http://c4:11235', crawl4aiToken: 's', fetchImpl: impl });

    expect((await tools.fetchPage('https://a.dev')).length).toBe(8000);
  });
});

describe('sources', () => {
  it('says what each side resolved to', () => {
    expect(createWebTools({}).sources).toEqual({ search: 'none', fetch: 'none' });
    expect(createWebTools({ searxngUrl: 'http://s', crawl4aiUrl: 'http://c', crawl4aiToken: 't' }).sources).toEqual({ search: 'searxng', fetch: 'crawl4ai' });
  });
});

describe('reading a page for a run', () => {
  it('asks whether the page is on the open internet before anything fetches it, crawl4ai included', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => { calls.push(String(input)); return Response.json({ markdown: 'page' }); }) as typeof fetch;
    const tools = createWebTools({ fetchImpl, crawl4aiUrl: 'http://crawl4ai:11235', crawl4aiToken: 't', pageCheck: async (url) => (url.includes('169.254') ? '169.254.169.254 is a private, loopback, mesh or reserved address' : undefined) });
    expect(await tools.readPage('http://169.254.169.254/latest/meta-data/')).toEqual({ ok: false, declined: true, text: 'Koala fetches only pages on the open internet, and not this one: 169.254.169.254 is a private, loopback, mesh or reserved address.' });
    expect(calls).toEqual([]);
    expect((await tools.readPage('https://example.com/')).ok).toBe(true);
  });
});
