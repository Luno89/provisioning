import { fieldsOf } from '../../platform/lib/request-fields.js';
import { dependencyFetch } from '@koala/engine-core/http';

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
  searxngFetch?: typeof fetch | undefined;
  crawl4aiFetch?: typeof fetch | undefined;
  pageCheck?: ((url: string) => Promise<string | undefined>) | undefined;
}

export type SearchOutcome =
  | { hits: SearchHit[]; unavailable: false }
  | { hits: []; unavailable: true; reason: string };

export type WebSearchFn = (query: string) => Promise<SearchOutcome>;

export function renderSearchOutcome(query: string, outcome: SearchOutcome): Record<string, unknown> {
  if (outcome.unavailable) {
    return {
      query,
      unavailable: true,
      error: `Search is unavailable: ${outcome.reason}`,
      note: 'This says NOTHING about whether results exist. Rephrasing will not help. Work from what '
        + 'you already have, and say in your summary that search was down.',
    };
  }
  if (!outcome.hits.length) {
    return { query, results: [], note: 'SearXNG answered with no matches for this query. Different terms may help.' };
  }
  return { query, results: outcome.hits };
}

export interface PageOutcome {
  ok: boolean;
  text: string;
  declined?: boolean;
  hiddenRemoved?: number;
}

export interface WebTools {
  search: (query: string, signal?: AbortSignal) => Promise<SearchOutcome>;
  fetchPage: (url: string, signal?: AbortSignal) => Promise<string>;
  readPage: (url: string, signal?: AbortSignal) => Promise<PageOutcome>;
  sources: { search: 'searxng' | 'none'; fetch: 'crawl4ai' | 'none' };
}

const MAX_PAGE_CHARS = 8000;

type Asked = { res: Response } | { failed: string };

async function ask(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Asked> {
  try {
    return { res: await doFetch(url, { ...init, ...(signal ? { signal } : {}) }) };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { failed: (err as Error).message };
  }
}

async function bodyJson(res: Response): Promise<{ json: unknown } | { failed: string }> {
  try {
    return { json: await res.json() };
  } catch (err) {
    return { failed: `its answer could not be read: ${(err as Error).message}` };
  }
}

async function searxng(doFetch: typeof fetch, base: string, query: string, signal?: AbortSignal): Promise<SearchHit[] | { failed: string }> {
  const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const asked = await ask(doFetch, url, { headers: { accept: 'application/json' } }, signal);
  if ('failed' in asked) return asked;
  if (!asked.res.ok) return { failed: `SearXNG answered ${asked.res.status}` };
  const body = await bodyJson(asked.res);
  if ('failed' in body) return { failed: `SearXNG's ${body.failed}` };
  const { results } = fieldsOf(body.json);
  if (!Array.isArray(results)) return { failed: 'SearXNG answered without a list of results' };

  return results.slice(0, 5).map((r) => {
    const hit = fieldsOf(r);
    return {
      title: String(hit.title ?? ''),
      snippet: String(hit.content ?? ''),
      url: String(hit.url ?? ''),
    };
  }).filter((h) => h.url);
}

function crawl4ai(doFetch: typeof fetch, base: string, token: string) {
  const root = base.replace(/\/$/, '');

  return async (url: string, signal?: AbortSignal): Promise<PageOutcome> => {
    const asked = await ask(doFetch, `${root}/md`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
    }, signal);
    if ('failed' in asked) return { ok: false, text: `The page could not be read: ${asked.failed}` };
    if (!asked.res.ok) return { ok: false, text: `The page could not be read: Crawl4AI answered ${asked.res.status}` };
    const body = await bodyJson(asked.res);
    if ('failed' in body) return { ok: false, text: `The page could not be read: Crawl4AI's ${body.failed}` };
    const { markdown: said } = fieldsOf(body.json);
    const markdown = typeof said === 'string' ? said.trim() : '';
    if (!markdown) return { ok: false, text: 'The page could not be read: Crawl4AI found no text on it' };
    return { ok: true, text: markdown.slice(0, MAX_PAGE_CHARS) };
  };
}

export function createWebTools(config: WebToolsConfig = {}): WebTools {
  const doFetch = config.fetchImpl ?? dependencyFetch;
  const scrape = config.crawl4aiUrl && config.crawl4aiToken
    ? crawl4ai(config.crawl4aiFetch ?? doFetch, config.crawl4aiUrl, config.crawl4aiToken)
    : undefined;

  return {
    sources: { search: config.searxngUrl ? 'searxng' : 'none', fetch: scrape ? 'crawl4ai' : 'none' },

    async search(query: string, signal?: AbortSignal): Promise<SearchOutcome> {
      if (!query.trim()) return { hits: [], unavailable: false };
      if (!config.searxngUrl) return { hits: [], unavailable: true, reason: 'no SearXNG is set up for this Koala' };
      const hits = await searxng(config.searxngFetch ?? doFetch, config.searxngUrl, query, signal);
      return 'failed' in hits ? { hits: [], unavailable: true, reason: hits.failed } : { hits, unavailable: false };
    },

    async readPage(url: string, signal?: AbortSignal): Promise<PageOutcome> {
      if (!/^https?:\/\//i.test(url)) return { ok: false, text: 'Only http and https URLs can be fetched.' };
      const refused = await config.pageCheck?.(url);
      if (refused) return { ok: false, declined: true, text: `Koala fetches only pages on the open internet, and not this one: ${refused}.` };
      if (!scrape) return { ok: false, text: 'Pages cannot be read: no Crawl4AI is set up for this Koala' };
      return scrape(url, signal);
    },

    async fetchPage(url: string, signal?: AbortSignal): Promise<string> {
      return (await this.readPage(url, signal)).text;
    },
  };
}
