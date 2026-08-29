
export interface CrawlSpec {
  url: string;
  maxDepth?: number;
  maxPages?: number;
  domains?: string[];
  keywords?: string[];
}

export interface FetchedPage {
  url: string;
  markdown: string;
  links: string[];
  error?: string;
}

export function buildBatchPayload(urls: string[]): { urls: string[] } {
  return { urls };
}

export function readCrawlResults(body: unknown): FetchedPage[] {
  const b = (body ?? {}) as Record<string, any>;
  const results: any[] = Array.isArray(b.results) ? b.results : Array.isArray(b.result) ? b.result : [];
  return results.map((r) => {
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

const SKIP = /\.(png|jpe?g|gif|svg|webp|ico|css|js|zip|tar|gz|mp4|mp3|woff2?|ttf|eot)(\?|$)/i;

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
