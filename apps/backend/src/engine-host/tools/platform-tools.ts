import type { ToolHandler, ToolOutcome } from '@koala/engine-core';

export interface SearchHit {
  title?: string;
  url?: string;
  snippet?: string;
}

export interface SearchOutcomeLike {
  results?: SearchHit[];
  error?: string;
}

export interface WebTools {
  search(query: string): Promise<SearchOutcomeLike>;
  fetchPage(url: string): Promise<{ ok: boolean; text: string; declined?: boolean }>;
}

export interface PlatformToolOptions {
  web?: WebTools | undefined;
}

export type PlatformToolsOptions = PlatformToolOptions;

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

const renderHits = (hits: SearchHit[]): string =>
  hits
    .map((hit, index) => [
      `${index + 1}. ${hit.title ?? 'untitled'}`,
      hit.url ? `   ${hit.url}` : undefined,
      hit.snippet ? `   ${hit.snippet}` : undefined,
    ].filter(Boolean).join('\n'))
    .join('\n');


export function createPlatformTools(options: PlatformToolOptions): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};

  if (options.web) {
    const web = options.web;

    handlers.search_web = async ({ parsed }): Promise<ToolOutcome> => {
      const query = asString(parsed, 'query') ?? asString(parsed, 'q');
      if (!query) return { ok: false, digest: 'this call needs a "query"', content: '' };

      const outcome = await web.search(query);
      if (outcome.error) return { ok: false, digest: outcome.error, content: outcome.error };

      const hits = outcome.results ?? [];
      if (hits.length === 0) {
        return { ok: true, digest: `nothing came back for "${query}"`, content: '' };
      }

      const rendered = renderHits(hits);
      return { ok: true, digest: rendered, content: rendered };
    };

    handlers.fetch_web_page = async ({ parsed }): Promise<ToolOutcome> => {
      const url = asString(parsed, 'url');
      if (!url) return { ok: false, digest: 'this call needs a "url"', content: '' };

      const page = await web.fetchPage(url);
      return { ok: page.ok, digest: page.text, content: page.text, ...(page.declined ? { declined: page.declined } : {}) };
    };
  }

  return handlers;
}
