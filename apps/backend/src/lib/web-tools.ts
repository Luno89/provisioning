/**
 * How the agent reaches the web — through a deployed service when there is one, by scraping when
 * there is not.
 *
 * ── WHY THIS EXISTS ──
 * The built-in versions do not work well enough to be useful, and the failure is silent. Measured
 * on a real conversation: the model searched, fetched two pages, searched again, and never answered
 * — because `fetch_web_page` strips tags from raw HTML, and every page it reached was
 * JavaScript-rendered. `weather.com` returned 200 with no air-quality figure anywhere in the markup.
 * The same URL through Crawl4AI returns 3,618 characters of markdown with the figure in it.
 *
 * Search has the same shape of problem one step earlier: parsing DuckDuckGo's HTML with a regex
 * works until DuckDuckGo changes its markup, and hands back redirect URLs rather than destinations.
 *
 * ── RESOLUTION, NOT REPLACEMENT ──
 * Deployed service → environment variable → the built-in scrape. The same chain
 * `credential-resolver.ts` uses, and for the same reason: a platform that only works once you have
 * deployed two extra services is a platform nobody can start using. The scrape stays as the floor.
 *
 * Every path degrades rather than throws. A search that fails returns no results, which the model
 * can act on; an exception would fail the whole turn and lose a reply that had already streamed.
 */

export interface SearchHit {
  title: string;
  snippet: string;
  url: string;
}

export interface WebToolsConfig {
  /** SearXNG base URL, e.g. `http://searxng.searxng.svc.cluster.local:8080`. */
  searxngUrl?: string | undefined;
  /** Crawl4AI base URL, e.g. `http://crawl4ai.crawl4ai.svc.cluster.local:11235`. */
  crawl4aiUrl?: string | undefined;
  /**
   * The `api_token` the Crawl4AI deployment was configured with, sent as a bearer token.
   *
   * Not optional: every route 401s without it, and `security.enabled: false` does NOT open it up
   * (verified against 0.9.2). It also decides the service's bind address — see
   * constructs/crawl4ai-native.ts.
   */
  crawl4aiToken?: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface WebTools {
  search: (query: string) => Promise<SearchHit[]>;
  fetchPage: (url: string) => Promise<string>;
  /** Which implementation each side resolved to, so a run can say how it reached the web. */
  sources: { search: 'searxng' | 'duckduckgo'; fetch: 'crawl4ai' | 'strip-tags' };
}

const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 60_000;
/** Enough for a model to work with; far beyond what a turn can afford to carry. */
const MAX_PAGE_CHARS = 8000;

/** Fetch with a deadline, returning undefined rather than throwing. A dead service is not an error here. */
async function tryFetch(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | undefined> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: abort.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DuckDuckGo's HTML, parsed.
 *
 * Kept as the floor rather than deleted: it needs no deployment, and something is better than a
 * platform that cannot search until two services are running. Its results still go through the
 * `uddg` unwrapping, because the raw hrefs are redirects and handing one to a fetcher wastes a
 * round trip at best.
 */
async function duckduckgo(doFetch: typeof fetch, query: string): Promise<SearchHit[]> {
  const res = await tryFetch(doFetch, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  }, SEARCH_TIMEOUT_MS);
  if (!res?.ok) return [];

  const html = await res.text().catch(() => '');
  const hits: SearchHit[] = [];
  const pattern = /<a class="result__url"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  for (const match of html.matchAll(pattern)) {
    if (hits.length >= 5) break;
    const raw = (match[1] ?? '').replace(/&amp;/g, '&');
    const redirect = /uddg=([^&]+)/.exec(raw);
    const url = redirect?.[1] ? decodeURIComponent(redirect[1]) : raw;
    const title = (match[2] ?? '').replace(/<[^>]+>/g, '').trim();
    const snippet = (match[3] ?? '').replace(/<[^>]+>/g, '').trim();
    if (title && url) hits.push({ title, snippet, url });
  }
  return hits;
}

/** SearXNG's JSON API. Needs `json` in its `search.formats` — it is off by default. */
async function searxng(doFetch: typeof fetch, base: string, query: string): Promise<SearchHit[] | undefined> {
  const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await tryFetch(doFetch, url, { headers: { accept: 'application/json' } }, SEARCH_TIMEOUT_MS);
  // Undefined, not an empty list: the caller falls back to scraping, where an empty list would
  // read as "nothing on the internet matches" and end the search there.
  if (!res?.ok) return undefined;

  const body = await res.json().catch(() => undefined) as { results?: unknown[] } | undefined;
  if (!Array.isArray(body?.results)) return undefined;

  return body.results.slice(0, 5).map((r) => {
    const hit = r as { title?: unknown; content?: unknown; url?: unknown };
    return {
      title: String(hit.title ?? ''),
      // SearXNG calls the snippet `content`.
      snippet: String(hit.content ?? ''),
      url: String(hit.url ?? ''),
    };
  }).filter((h) => h.url);
}

/**
 * Strips tags from raw HTML — the built-in fetcher, kept as the floor.
 *
 * Adequate for a static page and useless for anything rendered client-side, which is most of the
 * web now. That is the whole reason Crawl4AI is worth deploying.
 */
async function stripTags(doFetch: typeof fetch, url: string): Promise<string> {
  const res = await tryFetch(doFetch, url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  }, FETCH_TIMEOUT_MS);
  if (!res) return 'Failed to fetch page.';
  if (!res.ok) return `HTTP error ${res.status}`;

  const html = await res.text().catch(() => '');
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PAGE_CHARS);
}

/**
 * Crawl4AI, which renders the page first and returns markdown.
 *
 * ── AUTHENTICATION, VERIFIED AGAINST A DEPLOYED 0.9.2 ──
 * The `api_token` goes straight into `Authorization: Bearer`. There is no token exchange.
 *
 * This is worth stating because the service also exposes `POST /token`, which looks like the way
 * in and is not: it reads `config.security.api_token` from the config FILE and has no environment
 * fallback, so on an env-var-configured deployment it answers `403 no api_token is configured`
 * forever — while the auth gate, which does read the environment, is happily enforcing on every
 * other route. An implementation built around `/token` therefore fails against a service that is
 * running perfectly. `X-API-Token` is not accepted either.
 */
function crawl4ai(doFetch: typeof fetch, base: string, token: string) {
  const root = base.replace(/\/$/, '');

  return async (url: string): Promise<string | undefined> => {
    const res = await tryFetch(doFetch, `${root}/md`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
    }, FETCH_TIMEOUT_MS);
    if (!res?.ok) return undefined;

    const body = await res.json().catch(() => undefined) as { markdown?: unknown } | undefined;
    const markdown = typeof body?.markdown === 'string' ? body.markdown : undefined;
    // An empty render is a failure worth falling back from, not a page with nothing on it.
    return markdown?.trim() ? markdown.slice(0, MAX_PAGE_CHARS) : undefined;
  };
}

export function createWebTools(config: WebToolsConfig = {}): WebTools {
  const doFetch = config.fetchImpl ?? fetch;
  const scrape = config.crawl4aiUrl && config.crawl4aiToken
    ? crawl4ai(doFetch, config.crawl4aiUrl, config.crawl4aiToken)
    : undefined;

  return {
    sources: {
      search: config.searxngUrl ? 'searxng' : 'duckduckgo',
      fetch: scrape ? 'crawl4ai' : 'strip-tags',
    },

    async search(query: string): Promise<SearchHit[]> {
      if (!query.trim()) return [];
      if (config.searxngUrl) {
        const hits = await searxng(doFetch, config.searxngUrl, query);
        // Falls back only when the service could not answer. A service that answered with nothing
        // has answered, and re-asking DuckDuckGo would present its results as the same search.
        if (hits) return hits;
      }
      return duckduckgo(doFetch, query);
    },

    async fetchPage(url: string): Promise<string> {
      if (!/^https?:\/\//i.test(url)) return 'Only http and https URLs can be fetched.';
      if (scrape) {
        const markdown = await scrape(url);
        if (markdown) return markdown;
      }
      return stripTags(doFetch, url);
    },
  };
}
