
export interface SearchHit {
  title: string;
  snippet: string;
  url: string;
}

export interface WebToolsConfig {
  searxngUrl?: string | undefined;
  crawl4aiUrl?: string | undefined;
  crawl4aiToken?: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface SearchOutcome {
  hits: SearchHit[];
  answeredBy?: 'searxng' | 'duckduckgo';
  unavailable: boolean;
}

export type WebSearchFn = (query: string) => Promise<SearchOutcome>;

export function renderSearchOutcome(query: string, outcome: SearchOutcome): Record<string, unknown> {
  if (outcome.unavailable) {
    return {
      query,
      unavailable: true,
      error: 'Search is unavailable — no backend could be reached.',
      note: 'This says NOTHING about whether results exist. Rephrasing will not help. Work from what '
        + 'you already have, and say in your summary that search was down.',
    };
  }
  if (!outcome.hits.length) {
    return {
      query,
      source: outcome.answeredBy,
      results: [],
      note: `${outcome.answeredBy} answered with no matches for this query. Different terms may help.`,
    };
  }
  return { query, source: outcome.answeredBy, results: outcome.hits };
}

export interface WebTools {
  search: (query: string) => Promise<SearchOutcome>;
  fetchPage: (url: string) => Promise<string>;
  sources: { search: 'searxng' | 'duckduckgo'; fetch: 'crawl4ai' | 'strip-tags' };
}

const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_PAGE_CHARS = 8000;

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

async function duckduckgo(doFetch: typeof fetch, query: string): Promise<SearchHit[] | undefined> {
  const res = await tryFetch(doFetch, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  }, SEARCH_TIMEOUT_MS);
  if (!res?.ok) return undefined;

  const html = await res.text().catch(() => '');
  if (/anomaly|unusual traffic|blocked/i.test(html) && !html.includes('result__url')) return undefined;

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

async function searxng(doFetch: typeof fetch, base: string, query: string): Promise<SearchHit[] | undefined> {
  const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await tryFetch(doFetch, url, { headers: { accept: 'application/json' } }, SEARCH_TIMEOUT_MS);
  if (!res?.ok) return undefined;

  const body = await res.json().catch(() => undefined) as { results?: unknown[] } | undefined;
  if (!Array.isArray(body?.results)) return undefined;

  return body.results.slice(0, 5).map((r) => {
    const hit = r as { title?: unknown; content?: unknown; url?: unknown };
    return {
      title: String(hit.title ?? ''),
      snippet: String(hit.content ?? ''),
      url: String(hit.url ?? ''),
    };
  }).filter((h) => h.url);
}

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

    async search(query: string): Promise<SearchOutcome> {
      if (!query.trim()) return { hits: [], unavailable: false };

      if (config.searxngUrl) {
        const hits = await searxng(doFetch, config.searxngUrl, query);
        if (hits) return { hits, answeredBy: 'searxng', unavailable: false };
      }

      const hits = await duckduckgo(doFetch, query);
      if (hits) return { hits, answeredBy: 'duckduckgo', unavailable: false };

      return { hits: [], unavailable: true };
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
