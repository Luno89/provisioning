/**
 * One batch of an ingest: fetch it, store it, queue what it linked to.
 *
 * ── WHY THIS IS ONE ACTIVITY AND NOT TWO ──
 * It was two — fetch, then store — and that put every fetched byte through the workflow twice, once
 * as an activity result and once as the next activity's argument. Both land in Temporal's event
 * history, which is replayed in full on every worker that picks the workflow up, warns at 10 MB and
 * is refused at 50.
 *
 * Measured on a real 24-page ingest: **89,656 bytes of history per page**, against pages averaging
 * 10,568 bytes. That crawl would have been refused at around 550 pages.
 *
 * Fetching and storing in one activity means the markdown is never an argument or a result. What
 * comes back is three numbers. The bytes go crawler → database, and the workflow only ever learns
 * how many there were.
 *
 * ── THE MODEL IS STILL NOT IN THIS FILE ──
 * That was the original point and it survives: pages reach storage without passing through a
 * context window, which is what makes the size of the target irrelevant. Measured before any of
 * this existed, a request to ingest 7,142,257 bytes through an agent produced 134 characters,
 * because every byte had to be read by the agent in order to be stored.
 */
import { createDatabase } from '../lib/db-interface.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';
import { crawlEndpoint, liveDeployment } from '../lib/web-tools-resolver.js';
import { ApplicationFailure } from '@temporalio/common';
import { buildBatchPayload, readCrawlResults, canonical, hostOf, usableLinks } from '../lib/crawl-client.js';
import { toPage, type CorpusPage } from '../lib/corpus.js';
import { frontierRow, followsLinks, type FrontierClaim } from '../lib/frontier.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Where this owner's crawler is, or a failure that says which kind of nothing it was.
 *
 * The distinction matters because Temporal's default retry policy is unlimited. A crawler that is
 * briefly unreachable — a restarting pod, a dropped port-forward — should be waited out. An owner
 * with no crawler at all never becomes one by asking again, and retrying it looks exactly like a
 * slow crawl: measured here, a probe with the wrong owner id spun for seven minutes across twelve
 * attempts, reporting nothing but `error: {}`.
 */
async function endpoint(ownerId: string) {
  const db = createDatabase();
  await db.init();
  try {
    const found = await crawlEndpoint(db, ownerId);
    if (found) return found;
    // Reusing the resolver's own notion of live, rather than restating the predicate here and
    // letting the two drift.
    const deployed = liveDeployment(await db.getDeployments(), 'crawl4ai', ownerId);
    if (!deployed) {
      throw ApplicationFailure.nonRetryable(
        `No running Crawl4AI deployment belongs to owner ${ownerId}, so nothing can be ingested.`,
        'NoCrawler',
      );
    }
    throw new Error(`Crawl4AI deployment "${deployed.name}" is deployed but not reachable right now.`);
  } finally {
    await db.close();
  }
}

export interface SeedFrontierArgs {
  ingestId: string;
  seed: string;
  keywords: string[];
}

/** Puts the seed in the queue. Everything after this is discovered by crawling. */
export async function SeedFrontierActivity(args: SeedFrontierArgs): Promise<{ queued: number }> {
  const db = createDatabase();
  await db.init();
  try {
    return { queued: await db.enqueueFrontier([frontierRow(args.ingestId, args.seed, 0, args.keywords)]) };
  } finally {
    await db.close();
  }
}

export interface NextBatchArgs {
  ingestId: string;
  limit: number;
}

export interface NextBatchResult {
  batch: FrontierClaim[];
  /** How many URLs are still queued behind this batch. The workflow's only view of progress. */
  remaining: number;
}

/**
 * The next pages to fetch, and how many are left behind them.
 *
 * Deliberately does not mutate. The read is in a total order, so a retry of this activity returns
 * the batch it returned before; the batch is closed by CrawlBatchActivity once its pages are
 * actually stored. Claiming here instead would mean a retried claim silently skipped pages.
 */
export async function NextBatchActivity(args: NextBatchArgs): Promise<NextBatchResult> {
  const db = createDatabase();
  await db.init();
  try {
    const batch = await db.claimFrontier(args.ingestId, args.limit);
    return { batch, remaining: await db.countFrontier(args.ingestId) };
  } finally {
    await db.close();
  }
}

export interface CrawlBatchArgs {
  ownerId: string;
  ingestId: string;
  projectId?: string | undefined;
  batch: FrontierClaim[];
  /** Hosts links may lead to. A crawl that leaves these is a walk of the whole web. */
  allowed: string[];
  keywords: string[];
  maxDepth: number;
}

export interface CrawlBatchResult {
  stored: number;
  bytes: number;
  failed: number;
  /** Newly queued URLs. A count, never the URLs — those stay in the frontier collection. */
  queued: number;
  /** Bounded by the batch size, so this stays small enough to be a workflow value. */
  hosts: string[];
}

export async function CrawlBatchActivity(args: CrawlBatchArgs): Promise<CrawlBatchResult> {
  if (!args.batch.length) return { stored: 0, bytes: 0, failed: 0, queued: 0, hosts: [] };

  const { base, token } = await endpoint(args.ownerId);
  const urls = args.batch.map((b) => b.url);
  const res = await fetch(`${base}/crawl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(buildBatchPayload(urls)),
  });
  if (!res.ok) {
    throw new Error(`Crawl4AI refused the batch: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const fetched = readCrawlResults(await res.json());

  const db = createDatabase();
  await db.init();
  try {
    const usable = fetched.filter((p) => !p.error && p.markdown.trim());
    const stored: CorpusPage[] = usable.map((p) => toPage(p, {
      // Deterministic in the URL, so a batch retried after a worker restart replaces its pages
      // rather than doubling the corpus.
      id: `${args.ingestId}:${p.url}`,
      ownerId: args.ownerId,
      ingestId: args.ingestId,
      projectId: args.projectId,
    }));
    await db.saveCorpusPages(stored);

    /**
     * Links are queued at the depth of the page that carried them, plus one, and only while there
     * is depth left to spend. Each page's own depth is used rather than the batch's — a batch can
     * straddle two levels, and treating it as one would let a crawl run a level deeper than asked.
     */
    const depthOf = new Map(args.batch.map((b) => [b.url, b.depth]));
    const toQueue = [];
    for (const page of usable) {
      const depth = depthOf.get(page.url) ?? depthOf.get(canonical(page.url) ?? '') ?? 0;
      if (!followsLinks(depth, args.maxDepth)) continue;
      // `seen` used to be a Set in the workflow; the frontier's unique id does it now, so an empty
      // one here is correct — enqueueFrontier drops what is already queued.
      for (const link of usableLinks(page.links, args.allowed, new Set())) {
        toQueue.push(frontierRow(args.ingestId, link, depth + 1, args.keywords));
      }
    }
    const queued = await db.enqueueFrontier(toQueue);

    // Closed only now, once the pages are actually in the corpus. A batch that failed mid-way is
    // still pending, so a retry picks it up rather than losing it.
    await db.completeFrontier(args.ingestId, urls);

    const bytes = stored.reduce((n, p) => n + p.bytes, 0);
    const failed = args.batch.length - stored.length;
    console.log(`[Crawl] stored ${stored.length} page(s), ${bytes} bytes, ${failed} failed, queued ${queued}`);
    return {
      stored: stored.length,
      bytes,
      failed,
      queued,
      hosts: [...new Set(stored.map((p) => p.host).filter(Boolean))],
    };
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

/** Drops a finished crawl's queue. At this scale, leaving it is millions of dead rows per ingest. */
export async function DiscardFrontierActivity(args: { ingestId: string }): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    await db.deleteFrontier(args.ingestId);
  } finally {
    await db.close();
  }
}

/** A fresh id for one ingest run. Here rather than in the workflow, which must stay deterministic. */
export async function NewIngestIdActivity(): Promise<{ ingestId: string }> {
  return { ingestId: uuidv4() };
}

export { buildWebTools, hostOf };
