/**
 * A crawled corpus: the pages themselves, and how an agent asks about them.
 *
 * ── WHY PAGES ARE RECORDS AND NOT A FIELD ──
 * A research leaf's answer lives in `findings`, capped at 20,000 characters, because it is an
 * answer. A corpus is not an answer — it is the material one is written from, and it is routinely
 * megabytes. Measured: ingesting a 7,142,257-byte document into `findings` produced 134 characters.
 *
 * ── AND WHY THE AGENT NEVER RECEIVES ONE ──
 * The whole point of moving ingestion into a workflow is that the bytes stop passing through a
 * context window. Storing them and then handing a page back to the model would give that up at the
 * last step. So the only way in is `search`, which returns SNIPPETS: enough to judge relevance and
 * to quote, never the document.
 *
 * A page is capped anyway — a document store has its own limits, and one pathological page should
 * not be able to fail a whole crawl.
 */

/** Beyond this a single page is truncated. Generous for prose; far below the store's own ceiling. */
export const MAX_PAGE_CHARS = 200_000;

/** How much text comes back around each hit. Enough to judge and to quote, far short of a page. */
export const SNIPPET_CHARS = 400;

/** The most hits one search returns, so a common word cannot flood a prompt. */
export const MAX_HITS = 12;

export interface CorpusPage {
  id: string;
  ownerId: string;
  /** The ingest run that fetched it, so a corpus can be replaced or removed as a unit. */
  ingestId: string;
  /** Which project's corpus this belongs to, when the ingest was for one. */
  projectId?: string;
  url: string;
  /** Host, kept separate so a search can be scoped without parsing every URL. */
  host: string;
  text: string;
  bytes: number;
  fetchedAt: string;
}

export interface CorpusHit {
  url: string;
  /** Text around the match, with the match inside it. */
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
    // The stored length, not the fetched one — a receipt should describe what is actually there.
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

/**
 * Finds a phrase across a corpus and returns the text around each hit.
 *
 * Plain substring matching, case-insensitive. Deliberately not a regular expression: the query
 * comes from a model, and a pattern like `(a+)+b` against a megabyte of text is a hang that looks
 * exactly like a slow crawl.
 *
 * One hit per page. A term that appears ninety times in one document would otherwise fill the
 * budget with a single source and hide every other page that mentions it.
 */
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
      // Ellipses so a mid-sentence start reads as a fragment rather than as the page's opening.
      snippet: `${from > 0 ? '…' : ''}${snippet}${from + SNIPPET_CHARS < page.text.length ? '…' : ''}`,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** What an ingest actually produced. The only thing an agent is handed when one finishes. */
export interface IngestReceipt {
  ingestId: string;
  seed: string;
  pages: number;
  bytes: number;
  /** Pages the crawler could not fetch. Reported, because a silent gap is worse than a small one. */
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
