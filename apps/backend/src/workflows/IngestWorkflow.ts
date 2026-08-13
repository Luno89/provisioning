import { proxyActivities, log } from '@temporalio/workflow';
import type {
  FetchBatchArgs, FetchBatchResult, StoreCrawlArgs, StoreCrawlResult,
} from '../activities/CrawlActivity.js';
import type { IngestReceipt } from '../lib/corpus.js';
// From lib/activity-timeouts.ts, not the activity file — importing a value from an activity pulls
// its dependency tree into this workflow's bundle, which Temporal's sandboxing cannot handle.
import { crawlActivityMeta } from '../lib/activity-timeouts.js';
import { canonical, hostOf, usableLinks, rank } from '../lib/crawl-client.js';

const { FetchBatchActivity } = proxyActivities<{ FetchBatchActivity: (a: FetchBatchArgs) => Promise<FetchBatchResult> }>({
  startToCloseTimeout: crawlActivityMeta.startToCloseTimeout,
});
const { StoreCrawlActivity } = proxyActivities<{ StoreCrawlActivity: (a: StoreCrawlArgs) => Promise<StoreCrawlResult> }>({
  startToCloseTimeout: crawlActivityMeta.storeTimeout,
});
const { NewIngestIdActivity } = proxyActivities<{ NewIngestIdActivity: () => Promise<{ ingestId: string }> }>({
  startToCloseTimeout: '1 minute',
});

/**
 * Pages per request. The service takes a list, and one round trip per page would dominate; too
 * large a batch makes a single failure expensive to retry.
 */
const BATCH = 8;

/** A crawl that has taken this many batches is stuck rather than slow. */
const MAX_BATCHES = 400;

export interface IngestArgs {
  ownerId: string;
  projectId?: string;
  url: string;
  maxDepth?: number;
  maxPages?: number;
  domains?: string[];
  keywords?: string[];
}

/**
 * Fetch a site into the corpus, without any of it passing through a model.
 *
 * ── WHY THIS IS A WORKFLOW ──
 * Ingestion is long-running, resumable and bounded by PAGES. An agent loop is bounded by steps and
 * by a context window, pays an inference pass per action, and carries every fetched byte through
 * that window in order to store it — which is why asking a research leaf to ingest a 7,142,257-byte
 * document produced 134 characters.
 *
 * ── AND WHY THE FRONTIER IS HERE ──
 * Crawl4AI's own deep-crawl strategy is refused from a network request: since 0.9 the Docker server
 * treats the request body as untrusted and gates the fields that drive unbounded work. Walking the
 * site here turns out to be better anyway. Each batch is a short retryable activity, the frontier is
 * visible in Temporal's history rather than inside a black box, and the crawl can be cancelled
 * between batches.
 *
 * Every bound is enforced in this loop — depth, page ceiling, allowed hosts — so a bad argument
 * costs a small crawl rather than an outage.
 */
export async function executeIngestWorkflow(args: IngestArgs): Promise<IngestReceipt> {
  // From an activity: a workflow must be deterministic, and a uuid is the canonical thing that is
  // not.
  const { ingestId } = await NewIngestIdActivity();

  const seed = canonical(args.url);
  if (!seed) throw new Error(`Not a usable URL: ${args.url}`);

  const maxDepth = Math.min(Math.max(0, args.maxDepth ?? 1), 4);
  const maxPages = Math.min(Math.max(1, args.maxPages ?? 50), 2000);
  const allowed = args.domains?.length ? args.domains : [hostOf(seed)!].filter(Boolean);
  const keywords = args.keywords ?? [];

  // `seen` is everything ever queued, not everything fetched — a URL linked from forty pages must
  // be enqueued once, not forty times.
  const seen = new Set<string>([seed]);
  let frontier: string[] = [seed];
  let depth = 0;
  let pages = 0;
  let bytes = 0;
  let failed = 0;
  const hosts = new Set<string>();

  for (let batchNo = 0; batchNo < MAX_BATCHES && frontier.length && pages < maxPages; batchNo++) {
    const batch = frontier.splice(0, Math.min(BATCH, maxPages - pages));
    const { pages: fetched } = await FetchBatchActivity({ ownerId: args.ownerId, urls: batch });

    const stored = await StoreCrawlActivity({
      ownerId: args.ownerId,
      ingestId,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      seed,
      pages: fetched.map((p) => ({
        url: p.url,
        markdown: p.markdown,
        ...(p.error ? { error: p.error } : {}),
      })),
    });
    pages += stored.stored;
    bytes += stored.bytes;
    failed += stored.failed;
    for (const p of fetched) {
      const host = hostOf(p.url);
      if (host) hosts.add(host);
    }

    /**
     * Links are collected only while there is depth left to spend.
     *
     * At the last depth the frontier is drained rather than grown, so the crawl ends on the pages
     * it already has rather than queueing thousands it will never fetch.
     */
    if (depth < maxDepth) {
      const found = usableLinks(fetched.flatMap((p) => p.links), allowed, seen);
      frontier = rank([...frontier, ...found], keywords);
    }

    // One batch is one level's worth of work here; depth advances when the current level is drained.
    if (!frontier.length || batch.length < BATCH) depth += 1;
    if (depth > maxDepth && !frontier.length) break;
  }

  log.info(`Ingest ${ingestId} stored ${pages} page(s), ${bytes} bytes, ${failed} failed`);
  return { ingestId, seed, pages, bytes, failed, hosts: [...hosts] };
}
