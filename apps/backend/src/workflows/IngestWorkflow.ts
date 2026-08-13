import { proxyActivities, continueAsNew, log } from '@temporalio/workflow';
import type {
  SeedFrontierArgs, NextBatchArgs, NextBatchResult, CrawlBatchArgs, CrawlBatchResult,
} from '../activities/CrawlActivity.js';
import type { IngestReceipt } from '../lib/corpus.js';
// From lib/activity-timeouts.ts, not the activity file — importing a value from an activity pulls
// its dependency tree into this workflow's bundle, which Temporal's sandboxing cannot handle.
import { crawlActivityMeta } from '../lib/activity-timeouts.js';
import { canonical, hostOf } from '../lib/crawl-client.js';

const { CrawlBatchActivity } = proxyActivities<{ CrawlBatchActivity: (a: CrawlBatchArgs) => Promise<CrawlBatchResult> }>({
  startToCloseTimeout: crawlActivityMeta.startToCloseTimeout,
});
const { NextBatchActivity } = proxyActivities<{ NextBatchActivity: (a: NextBatchArgs) => Promise<NextBatchResult> }>({
  startToCloseTimeout: crawlActivityMeta.storeTimeout,
});
const { SeedFrontierActivity } = proxyActivities<{ SeedFrontierActivity: (a: SeedFrontierArgs) => Promise<{ queued: number }> }>({
  startToCloseTimeout: crawlActivityMeta.storeTimeout,
});
const { DiscardFrontierActivity } = proxyActivities<{ DiscardFrontierActivity: (a: { ingestId: string }) => Promise<void> }>({
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

/**
 * Batches before handing over to a fresh run.
 *
 * Two activities per batch is roughly ten history events, so this keeps a run near 2,500 events —
 * comfortably inside the range where Temporal replays quickly, and an order of magnitude below the
 * 51,200 it refuses at. The crawl itself is not bounded by this; `continueAsNew` starts a new run
 * with an empty history and the same counters, which is what lets one ingest exceed any single
 * workflow's ceiling.
 */
const BATCHES_PER_RUN = 250;

/** Hosts are a label on the receipt, not a work list; one pathological crawl should not grow it forever. */
const MAX_HOSTS = 100;

/** Per ingest. A terabyte is many ingests — one workflow crawling the whole web is its own problem. */
const MAX_PAGES = 1_000_000;

/** Counters carried from one run to the next. Never any page content — that is the entire point. */
interface IngestProgress {
  ingestId: string;
  pages: number;
  bytes: number;
  failed: number;
  hosts: string[];
}

export interface IngestArgs {
  ownerId: string;
  projectId?: string;
  url: string;
  maxDepth?: number;
  maxPages?: number;
  domains?: string[];
  keywords?: string[];
  /** Set only by `continueAsNew`. Absent on the run a caller starts. */
  resume?: IngestProgress;
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
 * ── WHY THE FRONTIER IS NOT IN THIS FILE ──
 * Crawl4AI's own deep-crawl strategy is refused from a network request: since 0.9 the Docker server
 * treats the request body as untrusted and gates the fields that drive unbounded work. So the walk
 * is ours — but it does not live in these variables, because workflow variables are event history.
 *
 * Measured on a 24-page ingest of the previous version, which kept the frontier and the fetched
 * markdown in the workflow: 89,656 bytes of history per page, so it would have been refused at
 * around 550 pages. The frontier is a collection now (lib/frontier.ts) and the workflow holds three
 * counters, so what bounds a crawl is the page budget rather than Temporal's history limit.
 */
export async function executeIngestWorkflow(args: IngestArgs): Promise<IngestReceipt> {
  const seed = canonical(args.url);
  if (!seed) throw new Error(`Not a usable URL: ${args.url}`);

  const maxDepth = Math.min(Math.max(0, args.maxDepth ?? 1), 4);
  const maxPages = Math.min(Math.max(1, args.maxPages ?? 50), MAX_PAGES);
  const allowed = args.domains?.length ? args.domains : [hostOf(seed)!].filter(Boolean);
  const keywords = args.keywords ?? [];

  let progress: IngestProgress;
  if (args.resume) {
    progress = args.resume;
  } else {
    // From an activity: a workflow must be deterministic, and a uuid is the canonical thing that is
    // not.
    const { ingestId } = await NewIngestIdActivity();
    await SeedFrontierActivity({ ingestId, seed, keywords });
    progress = { ingestId, pages: 0, bytes: 0, failed: 0, hosts: [] };
  }

  const hosts = new Set(progress.hosts);
  let drained = false;

  for (let batchNo = 0; batchNo < BATCHES_PER_RUN; batchNo++) {
    if (progress.pages >= maxPages) break;

    const { batch } = await NextBatchActivity({
      ingestId: progress.ingestId,
      // The page budget is enforced by asking for less, so a frontier of millions cannot overrun it.
      limit: Math.min(BATCH, maxPages - progress.pages),
    });
    if (!batch.length) {
      drained = true;
      break;
    }

    const r = await CrawlBatchActivity({
      ownerId: args.ownerId,
      ingestId: progress.ingestId,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      batch,
      allowed,
      keywords,
      maxDepth,
    });
    progress.pages += r.stored;
    progress.bytes += r.bytes;
    progress.failed += r.failed;
    for (const h of r.hosts) if (hosts.size < MAX_HOSTS) hosts.add(h);
  }

  progress.hosts = [...hosts];

  /**
   * Out of batches but not out of pages: hand the rest to a fresh run.
   *
   * The new run starts with an empty event history and these five numbers. Nothing is re-fetched,
   * because what is left to do lives in the frontier collection rather than in the history being
   * discarded.
   */
  if (!drained && progress.pages < maxPages) {
    log.info(`Ingest ${progress.ingestId} continuing after ${progress.pages} page(s)`);
    await continueAsNew<typeof executeIngestWorkflow>({ ...args, resume: progress });
  }

  // The queue has done its job; at this scale leaving it behind is millions of dead rows per crawl.
  await DiscardFrontierActivity({ ingestId: progress.ingestId });

  log.info(`Ingest ${progress.ingestId} stored ${progress.pages} page(s), ${progress.bytes} bytes, ${progress.failed} failed`);
  return {
    ingestId: progress.ingestId,
    seed,
    pages: progress.pages,
    bytes: progress.bytes,
    failed: progress.failed,
    hosts: progress.hosts,
  };
}
