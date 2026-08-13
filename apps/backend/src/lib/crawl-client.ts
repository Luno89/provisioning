/**
 * Crawling with Crawl4AI, with the frontier owned here rather than by the service.
 *
 * ── WHY WE WALK THE SITE OURSELVES ──
 * Crawl4AI's library has BFS/DFS/BestFirst deep-crawl strategies, and the obvious design was to
 * hand it a `deep_crawl_strategy` and let it do the walking. The deployed service refuses:
 *
 *     400: field 'deep_crawl_strategy' is not permitted on CrawlerRunConfig from an untrusted request
 *
 * Since 0.9 the Docker server treats a network request body as an untrusted boundary and gates the
 * fields that can drive unbounded work. Setting it server-side would fix the error and lose the
 * point, because depth, page cap and keywords have to vary per request.
 *
 * `POST /crawl` with a list of URLs IS permitted, and returns full markdown plus every link it
 * found. That is everything a frontier needs, so the walk happens in the workflow — which is better
 * anyway: each batch is a short, retryable activity, the frontier is visible in Temporal's history,
 * and a crawl can be cancelled between batches instead of being a black box.
 *
 * Pure, except for the transport, so the parsing can be tested against the exact shapes the service
 * produces rather than only against one that happens to be up.
 */

export interface CrawlSpec {
  url: string;
  /** How far from the seed to follow links. 0 fetches only the seed. */
  maxDepth?: number;
  /** Hard ceiling on pages, whatever the depth allows. */
  maxPages?: number;
  /** Hosts links may lead to. Empty means the seed's own host. */
  domains?: string[];
  /** Words that make a page worth reaching first, when the budget will not cover everything. */
  keywords?: string[];
}

export interface FetchedPage {
  url: string;
  markdown: string;
  /** Every link found on the page, absolute. The raw material for the next depth. */
  links: string[];
  error?: string;
}

/** Batches are one request. The service takes a list, and a round trip per page would dominate. */
export function buildBatchPayload(urls: string[]): { urls: string[] } {
  return { urls };
}

/**
 * Reads a `POST /crawl` response.
 *
 * Defensive because this is a deployed service's shape, not a contract we control: a field that
 * moves between versions should degrade to "nothing found" rather than throwing inside a Temporal
 * activity, where the failure would be retried identically forever.
 */
export function readCrawlResults(body: unknown): FetchedPage[] {
  const b = (body ?? {}) as Record<string, any>;
  const results: any[] = Array.isArray(b.results) ? b.results : Array.isArray(b.result) ? b.result : [];
  return results.map((r) => {
    // `markdown` is a string in some versions and an object of renderings in others.
    const md = typeof r?.markdown === 'string'
      ? r.markdown
      : r?.markdown?.raw_markdown ?? r?.markdown?.fit_markdown ?? r?.cleaned_html ?? '';
    const internal: any[] = Array.isArray(r?.links?.internal) ? r.links.internal : [];
    const external: any[] = Array.isArray(r?.links?.external) ? r.links.external : [];
    return {
      url: String(r?.url ?? ''),
      markdown: String(md ?? ''),
      links: [...internal, ...external]
        .map((l) => String(l?.href ?? l ?? ''))
        .filter(Boolean),
      ...(r?.success === false
        ? { error: String(r?.error_message || `HTTP ${r?.status_code ?? 'error'}`) }
        : {}),
    };
  }).filter((p) => p.url);
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * A URL reduced to what makes two links the same page.
 *
 * The fragment goes, because `#install` and `#usage` are one document and fetching it twice spends
 * the page budget on nothing. A trailing slash goes for the same reason. The query string STAYS —
 * `?page=2` is a different page, and dropping it silently truncates paginated sites.
 */
export function canonical(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Extensions that are never worth a page of the budget when the goal is text. */
const SKIP = /\.(png|jpe?g|gif|svg|webp|ico|css|js|zip|tar|gz|mp4|mp3|woff2?|ttf|eot)(\?|$)/i;

/**
 * Which of a page's links are worth queueing.
 *
 * Filtered here rather than after fetching, because the cheapest page is the one never requested.
 */
export function usableLinks(links: string[], allowed: string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const raw of links) {
    const url = canonical(raw);
    if (!url || seen.has(url) || SKIP.test(url)) continue;
    const host = hostOf(url);
    if (!host || !allowed.includes(host)) continue;
    out.push(url);
    seen.add(url);
  }
  return out;
}

/**
 * Orders the frontier so a capped crawl spends its budget on what was asked for.
 *
 * The score is how many of the keywords appear in the URL. Crude on purpose: the alternative is
 * fetching a page to find out whether it was worth fetching, which is the cost being avoided. With
 * no keywords the order is discovery order, which is breadth-first and a reasonable default.
 */
export function rank(urls: string[], keywords: string[]): string[] {
  if (!keywords.length) return urls;
  const lower = keywords.map((k) => k.toLowerCase());
  return [...urls].sort((a, b) => score(b, lower) - score(a, lower));
}

function score(url: string, keywords: string[]): number {
  const u = url.toLowerCase();
  return keywords.reduce((n, k) => n + (u.includes(k) ? 1 : 0), 0);
}
