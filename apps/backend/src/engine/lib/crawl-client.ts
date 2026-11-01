import { type Fields, fieldsOf } from '../../platform/lib/request-fields.js';


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

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function markdownOf(result: Fields): unknown {
  if (typeof result.markdown === 'string') return result.markdown;
  const markdown = fieldsOf(result.markdown);
  return markdown.raw_markdown ?? markdown.fit_markdown ?? result.cleaned_html ?? '';
}

export function readCrawlResults(body: unknown): FetchedPage[] {
  const b = fieldsOf(body);
  const results = Array.isArray(b.results) ? b.results : listOf(b.result);
  return results.map((entry) => {
    const r = fieldsOf(entry);
    const links = fieldsOf(r.links);
    return {
      url: String(r.url ?? ''),
      markdown: String(markdownOf(r) ?? ''),
      links: [...listOf(links.internal), ...listOf(links.external)]
        .map((l) => String(fieldsOf(l).href ?? l ?? ''))
        .filter(Boolean),
      ...(r.success === false
        ? { error: String(r.error_message || `HTTP ${String(r.status_code ?? 'error')}`) }
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
