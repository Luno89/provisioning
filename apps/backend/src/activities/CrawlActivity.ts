/**
 * The two steps of an ingest: fetch a batch, store a batch.
 *
 * ── WHY THE FRONTIER IS NOT HERE ──
 * The obvious design was to hand Crawl4AI a `deep_crawl_strategy` and let it walk the site. The
 * deployed service refuses that from a network request — since 0.9 the Docker server treats a
 * request body as an untrusted boundary and gates the fields that drive unbounded work.
 *
 * So the walk lives in the workflow, and these activities are each short and idempotent, which is
 * what lets Temporal retry one without the crawl caring.
 *
 * ── THE MODEL IS NOT IN THIS FILE ──
 * That is the point of the whole design. Pages go from the crawler to the database without passing
 * through a context window, which is what makes the size of the target irrelevant. Measured before
 * this existed: a request to ingest 7,142,257 bytes produced 134 characters, because every byte had
 * to be read by the agent to be stored.
 */
import { createDatabase } from '../lib/db-interface.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';
import { crawlEndpoint } from '../lib/web-tools-resolver.js';
import { buildBatchPayload, readCrawlResults, type FetchedPage } from '../lib/crawl-client.js';
import { toPage, type CorpusPage } from '../lib/corpus.js';
import { v4 as uuidv4 } from 'uuid';

export interface StoreCrawlArgs {
  ownerId: string;
  ingestId: string;
  projectId?: string | undefined;
  seed: string;
  pages: { url: string; markdown: string; error?: string }[];
}

export interface StoreCrawlResult {
  stored: number;
  bytes: number;
  failed: number;
}

async function endpoint(ownerId: string) {
  const db = createDatabase();
  await db.init();
  try {
    const found = await crawlEndpoint(db, ownerId);
    if (!found) throw new Error('No Crawl4AI deployment is reachable, so nothing can be ingested.');
    return found;
  } finally {
    await db.close();
  }
}

export interface FetchBatchArgs {
  ownerId: string;
  urls: string[];
}

export interface FetchBatchResult {
  pages: FetchedPage[];
}

/**
 * One batch of pages, fetched and returned to the workflow.
 *
 * A batch rather than a page: the service takes a list, and a round trip per page would dominate a
 * crawl of any size. Short and idempotent, so Temporal can retry it without the workflow caring.
 *
 * The markdown goes straight back to the workflow and from there to the database. No model is
 * involved at any point, which is what makes the size of the target irrelevant — measured before
 * this existed, ingesting a 7,142,257-byte document through an agent produced 134 characters.
 */
export async function FetchBatchActivity(args: FetchBatchArgs): Promise<FetchBatchResult> {
  if (!args.urls.length) return { pages: [] };
  const { base, token } = await endpoint(args.ownerId);
  const res = await fetch(`${base}/crawl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(buildBatchPayload(args.urls)),
  });
  if (!res.ok) {
    throw new Error(`Crawl4AI refused the batch: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const pages = readCrawlResults(await res.json());
  console.log(`[Crawl] fetched ${pages.length}/${args.urls.length} page(s)`);
  return { pages };
}

export async function StoreCrawlActivity(args: StoreCrawlArgs): Promise<StoreCrawlResult> {
  const db = createDatabase();
  await db.init();
  try {
    const usable = args.pages.filter((p) => !p.error && p.markdown.trim());
    const failed = args.pages.length - usable.length;

    const stored: CorpusPage[] = usable.map((p) => toPage(p, {
      // Deterministic in the URL, so re-running an ingest replaces pages rather than duplicating
      // them — a crawl retried after a worker restart must not double the corpus.
      id: `${args.ingestId}:${p.url}`,
      ownerId: args.ownerId,
      ingestId: args.ingestId,
      projectId: args.projectId,
    }));
    await db.saveCorpusPages(stored);

    const bytes = stored.reduce((n, p) => n + p.bytes, 0);
    console.log(`[Crawl] stored ${stored.length} page(s), ${bytes} bytes, ${failed} failed`);
    return { stored: stored.length, bytes, failed };
  } finally {
    await db.close();
  }
}

/** Used by the tool that answers "what did that ingest find?" without handing over a page. */
export async function SearchCorpusActivity(
  args: { ownerId: string; query: string; ingestId?: string; projectId?: string },
): Promise<{ hits: { url: string; snippet: string }[] }> {
  const db = createDatabase();
  await db.init();
  try {
    const { search } = await import('../lib/corpus.js');
    const pages = await db.getCorpusPages({
      ownerId: args.ownerId,
      ...(args.ingestId ? { ingestId: args.ingestId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    });
    return { hits: search(pages, args.query) };
  } finally {
    await db.close();
  }
}

/** A fresh id for one ingest run. Here rather than in the workflow, which must stay deterministic. */
export async function NewIngestIdActivity(): Promise<{ ingestId: string }> {
  return { ingestId: uuidv4() };
}

export { buildWebTools };
