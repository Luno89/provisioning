/**
 * The behaviour that matters here is all in the seams: what happens when a service is configured
 * but down, answers but with nothing, or answers with something unparseable. Those are the states
 * that decide whether the agent gets a page or a wall of stripped tags — and none of them are
 * visible without a live model on one side and a live service on the other.
 */
import { describe, it, expect, vi } from 'vitest';
import { createWebTools } from './web-tools.js';

/** A fetch stub that answers by URL substring, and records what it was asked. */
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

    expect(await tools.search('kubernetes')).toEqual([{ title: 'T', snippet: 'S', url: 'https://x.dev' }]);
    // `format=json` is the whole reason the construct has to override the default settings — SearXNG
    // ships with JSON disabled and answers 403 to exactly this request until it is turned on.
    expect(calls[0]?.url).toContain('format=json');
  });

  it('falls back to scraping when the configured service is unreachable', async () => {
    const { impl } = stubFetch([
      ['searx', () => { throw new Error('ECONNREFUSED'); }],
      ['duckduckgo', { text: async () => DDG_HTML }],
    ]);
    const tools = createWebTools({ searxngUrl: 'http://searx:8080', fetchImpl: impl });

    // A deployment that went down must not take search with it — the point of the chain.
    expect(await tools.search('kubernetes')).toHaveLength(1);
  });

  it('does not fall back when the service answered with no results', async () => {
    const { impl, calls } = stubFetch([['searx', { json: async () => ({ results: [] }) }]]);
    const tools = createWebTools({ searxngUrl: 'http://searx:8080', fetchImpl: impl });

    expect(await tools.search('asdkjhasd')).toEqual([]);
    // Re-asking DuckDuckGo would present a DIFFERENT engine's results as the same search, and hide
    // a misconfigured SearXNG behind results that look fine.
    expect(calls).toHaveLength(1);
  });

  it('falls back when the service answers with a shape it should not', async () => {
    // A SearXNG without JSON enabled returns an HTML error page with a 200. Parsed as JSON that is
    // a throw, and treating it as "no results" would silently halve the agent's reach.
    const { impl } = stubFetch([
      ['searx', { json: async () => { throw new Error('not json'); } }],
      ['duckduckgo', { text: async () => DDG_HTML }],
    ]);
    const tools = createWebTools({ searxngUrl: 'http://searx:8080', fetchImpl: impl });

    expect(await tools.search('kubernetes')).toHaveLength(1);
  });

  it('unwraps a DuckDuckGo redirect into the destination', async () => {
    const { impl } = stubFetch([['duckduckgo', { text: async () => DDG_HTML }]]);
    const tools = createWebTools({ fetchImpl: impl });

    // The raw href is a duckduckgo.com/l/ redirect; handing that to the fetcher wastes a round trip
    // and gives the model a URL it cannot cite.
    expect((await tools.search('x'))[0]?.url).toBe('https://example.com/a');
  });

  it('reports no results rather than throwing when everything is down', async () => {
    const { impl } = stubFetch([['duckduckgo', () => { throw new Error('offline'); }]]);
    const tools = createWebTools({ fetchImpl: impl });

    // A throw here fails the whole turn and loses a reply that has already streamed to the user.
    await expect(tools.search('x')).resolves.toEqual([]);
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
    /**
     * `POST /token` looks like the way in and is a dead end: it reads the api_token from the config
     * FILE with no environment fallback, so on an env-configured deployment it answers 403 forever
     * while every other route authenticates fine. An implementation built around it fails against a
     * service that is working. Verified live against a deployed 0.9.2.
     */
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

    // An empty render means the browser failed, not that the page is blank — chromium OOMing in a
    // 64MB /dev/shm produces exactly this, and it is the most likely misconfiguration.
    expect(await tools.fetchPage('https://example.com')).toBe('Static content');
  });

  it('does not use the crawler when it has a URL but no token', async () => {
    // Deliberate: the token IS the authentication, so a crawler without one 401s on every request.
    // Trying anyway costs a round trip per fetch to reach the same fallback.
    const { impl } = stubFetch([['example.com', { text: async () => '<p>hi</p>' }]]);
    const tools = createWebTools({ crawl4aiUrl: 'http://c4:11235', fetchImpl: impl });

    expect(tools.sources.fetch).toBe('strip-tags');
    expect(await tools.fetchPage('https://example.com')).toBe('hi');
  });

  it('refuses a non-http URL before making any request', async () => {
    const { impl, calls } = stubFetch([]);
    const tools = createWebTools({ fetchImpl: impl });

    // The URL is model output. `file:///etc/passwd` reaching a fetcher that runs inside the cluster
    // is the whole SSRF surface of this tool.
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
