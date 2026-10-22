
export const MAX_PAGE_CHARS = 200_000;

export const SNIPPET_CHARS = 400;

export const MAX_HITS = 12;

export interface CorpusPage {
  id: string;
  ownerId: string;
  ingestId: string;
  projectId?: string;
  url: string;
  host: string;
  text: string;
  bytes: number;
  fetchedAt: string;
}

export interface CorpusHit {
  url: string;
  snippet: string;
}

export function toPage(
  raw: { url: string; markdown: string },
  meta: { id: string; ownerId: string; ingestId: string; projectId?: string | undefined; now?: string },
): CorpusPage {
  const text = raw.markdown.slice(0, MAX_PAGE_CHARS);
  return {
    id: meta.id,
    ownerId: meta.ownerId,
    ingestId: meta.ingestId,
    ...(meta.projectId ? { projectId: meta.projectId } : {}),
    url: raw.url,
    host: hostOf(raw.url),
    text,
    bytes: text.length,
    fetchedAt: meta.now ?? new Date().toISOString(),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function search(pages: CorpusPage[], query: string, limit = MAX_HITS): CorpusHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const hits: CorpusHit[] = [];
  for (const page of pages) {
    const at = page.text.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    const from = Math.max(0, at - Math.floor(SNIPPET_CHARS / 2));
    const snippet = page.text.slice(from, from + SNIPPET_CHARS).trim();
    hits.push({
      url: page.url,
      snippet: `${from > 0 ? '…' : ''}${snippet}${from + SNIPPET_CHARS < page.text.length ? '…' : ''}`,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export interface IngestReceipt {
  ingestId: string;
  seed: string;
  pages: number;
  bytes: number;
  failed: number;
  hosts: string[];
}

export function receiptFor(ingestId: string, seed: string, pages: CorpusPage[], failed: number): IngestReceipt {
  return {
    ingestId,
    seed,
    pages: pages.length,
    bytes: pages.reduce((n, p) => n + p.bytes, 0),
    failed,
    hosts: [...new Set(pages.map((p) => p.host).filter(Boolean))],
  };
}
