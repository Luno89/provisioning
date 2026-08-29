import { proxyActivities, continueAsNew, log } from '@temporalio/workflow';
import type {
  SeedFrontierArgs, NextBatchArgs, NextBatchResult, CrawlBatchArgs, CrawlBatchResult,
} from '../activities/CrawlActivity.js';
import type { IngestReceipt } from '../lib/corpus.js';
import { crawlActivityMeta } from '../lib/activity-timeouts.js';
import { canonical, hostOf } from '../lib/crawl-client.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { CrawlBatchActivity } = proxyActivities<{ CrawlBatchActivity: (a: CrawlBatchArgs) => Promise<CrawlBatchResult> }>({
  retry: ACTIVITY_RETRY, startToCloseTimeout: crawlActivityMeta.startToCloseTimeout,
});
const { NextBatchActivity } = proxyActivities<{ NextBatchActivity: (a: NextBatchArgs) => Promise<NextBatchResult> }>({
  retry: ACTIVITY_RETRY, startToCloseTimeout: crawlActivityMeta.storeTimeout,
});
const { SeedFrontierActivity } = proxyActivities<{ SeedFrontierActivity: (a: SeedFrontierArgs) => Promise<{ queued: number }> }>({
  retry: ACTIVITY_RETRY, startToCloseTimeout: crawlActivityMeta.storeTimeout,
});
const { DiscardFrontierActivity } = proxyActivities<{ DiscardFrontierActivity: (a: { ingestId: string }) => Promise<void> }>({
  retry: ACTIVITY_RETRY, startToCloseTimeout: crawlActivityMeta.storeTimeout,
});
const { NewIngestIdActivity } = proxyActivities<{ NewIngestIdActivity: () => Promise<{ ingestId: string }> }>({
  retry: ACTIVITY_RETRY, startToCloseTimeout: '1 minute',
});

const BATCH = 8;

const BATCHES_PER_RUN = 250;

const MAX_HOSTS = 100;

const MAX_PAGES = 1_000_000;

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
  resume?: IngestProgress;
}

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

  if (!drained && progress.pages < maxPages) {
    log.info(`Ingest ${progress.ingestId} continuing after ${progress.pages} page(s)`);
    await continueAsNew<typeof executeIngestWorkflow>({ ...args, resume: progress });
  }

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
