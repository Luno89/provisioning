import { describe, it, expect, vi } from 'vitest';
import { createWebTools } from './web-tools.js';

function stubFetch(routes: Array<[string, Partial<Response> | (() => Partial<Response>)]>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (input: any, init?: RequestInit) => {
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

const DDG_HTML = `
  <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">example.com/a</a>
  <a class="result__snippet">First snippet</a>
`;

describe('search', () => {
  it('uses SearXNG when one is configured', async () => {
    const { impl, calls } = stubFetch([
      ['searx', { json: async () => ({ results: [{ title: 'T', content: 'S', url: 'https://x.dev' }] }) }],
    ]);
    const tools = createWebTools({ searxngUrl: 'http://searx:8080', fetchImpl: impl });

    expect((await tools.search('kubernetes')).hits).toEqual([{ title: 'T', snippet: 'S', url: 'https://x.dev' }]);
    expect(calls[0]?.url).toContain('format=json');
  });

  it('falls back to scraping when the configured service is unreachable', async () => {
    const { impl } = stubFetch([
      ['searx', () => { throw new Error('ECONNREFUSED'); }],
      ['duckduckgo', { text: async () => DDG_HTML }],
    ]);
    const tools = createWebTools({ searxngUrl: 'http://searx:8080', fetchImpl: impl });

    const out = await tools.search('kubernetes');
    expect(out.hits).toHaveLength(1);
    expect(out.answeredBy).toBe('duckduckgo');
    expect(out.unavailable).toBe(false);
  });

  it('does not fall back when the service answered with no results', async () => {
    const { impl, calls } = stubFetch([['searx', { json: async () => ({ results: [] }) }]]);
    const tools = createWebTools({ searxngUrl: 'http://searx:8080', fetchImpl: impl });

    const answered = await tools.search('asdkjhasd');
    expect(answered.hits).toEqual([]);
    expect(answered.unavailable).toBe(false);
    expect(answered.answeredBy).toBe('searxng');
    expect(calls).toHaveLength(1);
  });

  it('falls back when the service answers with a shape it should not', async () => {
    const { impl } = stubFetch([
      ['searx', { json: async () => { throw new Error('not json'); } }],
      ['duckduckgo', { text: async () => DDG_HTML }],
    ]);
    const tools = createWebTools({ searxngUrl: 'http://searx:8080', fetchImpl: impl });

    expect((await tools.search('kubernetes')).hits).toHaveLength(1);
  });

  it('unwraps a DuckDuckGo redirect into the destination', async () => {
    const { impl } = stubFetch([['duckduckgo', { text: async () => DDG_HTML }]]);
    const tools = createWebTools({ fetchImpl: impl });

    expect((await tools.search('x')).hits[0]?.url).toBe('https://example.com/a');
  });

  it('reports UNAVAILABLE rather than empty when everything is down', async () => {
    const { impl } = stubFetch([['duckduckgo', () => { throw new Error('offline'); }]]);
    const tools = createWebTools({ fetchImpl: impl });

    const out = await tools.search('x');
    expect(out.unavailable).toBe(true);
    expect(out.hits).toEqual([]);
    expect(out.answeredBy).toBeUndefined();
  });

  it('treats a DuckDuckGo block page as unavailable, not as an empty topic', async () => {
    const { impl } = stubFetch([['duckduckgo', { text: async () => '<html>anomaly detected</html>' }]]);
    const tools = createWebTools({ fetchImpl: impl });

    expect((await tools.search('x')).unavailable).toBe(true);
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
    expect((calls[0]?.init?.headers as any).authorization).toBe('Bearer sekrit');
  });

  it('never calls the token endpoint', async () => {
    const { impl, calls } = crawlOk('page');
    const tools = createWebTools({ crawl4aiUrl: 'http://c4:11235', crawl4aiToken: 's', fetchImpl: impl });

    await tools.fetchPage('https://a.dev');
    expect(calls.some((c) => c.url.includes('/token'))).toBe(false);
  });

  it('falls back to stripping tags when the crawler cannot be reached', async () => {
    const { impl } = stubFetch([
      ['/md', () => { throw new Error('down'); }],
      ['example.com', { text: async () => '<html><body><p>Plain text</p></body></html>' }],
    ]);
    const tools = createWebTools({ crawl4aiUrl: 'http://c4:11235', crawl4aiToken: 's', fetchImpl: impl });

    expect(await tools.fetchPage('https://example.com')).toBe('Plain text');
  });

  it('falls back when the crawler renders an empty page', async () => {
    const { impl } = stubFetch([
      ['/md', { json: async () => ({ markdown: '   ' }) }],
      ['example.com', { text: async () => '<p>Static content</p>' }],
    ]);
    const tools = createWebTools({ crawl4aiUrl: 'http://c4:11235', crawl4aiToken: 's', fetchImpl: impl });

    expect(await tools.fetchPage('https://example.com')).toBe('Static content');
  });

  it('does not use the crawler when it has a URL but no token', async () => {
    const { impl } = stubFetch([['example.com', { text: async () => '<p>hi</p>' }]]);
    const tools = createWebTools({ crawl4aiUrl: 'http://c4:11235', fetchImpl: impl });

    expect(tools.sources.fetch).toBe('strip-tags');
    expect(await tools.fetchPage('https://example.com')).toBe('hi');
  });

  it('refuses a non-http URL before making any request', async () => {
    const { impl, calls } = stubFetch([]);
    const tools = createWebTools({ fetchImpl: impl });

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
  it('says which implementation each side resolved to', () => {
    expect(createWebTools({}).sources).toEqual({ search: 'duckduckgo', fetch: 'strip-tags' });
    expect(createWebTools({ searxngUrl: 'http://s', crawl4aiUrl: 'http://c', crawl4aiToken: 't' }).sources)
      .toEqual({ search: 'searxng', fetch: 'crawl4ai' });
  });
});
