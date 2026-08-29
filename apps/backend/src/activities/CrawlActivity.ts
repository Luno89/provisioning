import { createDatabase } from '../lib/db-interface.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';
import { crawlEndpoint, liveDeployment, corpusEndpoints, type CorpusEndpoints } from '../lib/web-tools-resolver.js';
import { ensureIndex, indexPages, ensureCollection, embedPages, searchCorpus, purgeCorpus } from '../lib/corpus-client.js';
import { ApplicationFailure } from '@temporalio/common';
import { buildBatchPayload, readCrawlResults, canonical, hostOf, usableLinks } from '../lib/crawl-client.js';
import { toPage, type CorpusPage } from '../lib/corpus.js';
import { frontierRow, followsLinks, type FrontierClaim } from '../lib/frontier.js';
import { v4 as uuidv4 } from 'uuid';

async function endpoint(ownerId: string) {
  const db = createDatabase();
  await db.init();
  try {
    const found = await crawlEndpoint(db, ownerId);
    if (found) return found;
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

function toDoc(p: CorpusPage) {
  return {
    url: p.url,
    host: p.host,
    owner_id: p.ownerId,
    ingest_id: p.ingestId,
    project_id: p.projectId ?? '',
    body: p.text,
    fetched_at: p.fetchedAt,
  };
}

export interface SeedFrontierArgs {
  ingestId: string;
  seed: string;
  keywords: string[];
}

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
  remaining: number;
}

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
  allowed: string[];
  keywords: string[];
  maxDepth: number;
}

export interface CrawlBatchResult {
  stored: number;
  bytes: number;
  failed: number;
  queued: number;
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
      id: `${args.ingestId}:${p.url}`,
      ownerId: args.ownerId,
      ingestId: args.ingestId,
      projectId: args.projectId,
    }));

    let indexed = 0;
    let embedded = 0;
    try {
      const ends = await corpusEndpoints(db, args.ownerId);
      if (ends.index) {
        await ensureIndex(ends.index.base);
        const docs = stored.map((p) => toDoc(p));
        indexed = await indexPages(ends.index.base, docs);
        if (ends.vectors && ends.embeddings) {
          await ensureCollection(ends.vectors.base, ends.vectors.apiKey);
          embedded = await embedPages(ends, docs);
        }
      }
    } catch (err: any) {
      console.warn(`[Crawl] corpus services unavailable, stored to the database only: ${err?.message}`);
    }

    await db.saveCorpusPages(stored);

    const depthOf = new Map(args.batch.map((b) => [b.url, b.depth]));
    const toQueue = [];
    for (const page of usable) {
      const depth = depthOf.get(page.url) ?? depthOf.get(canonical(page.url) ?? '') ?? 0;
      if (!followsLinks(depth, args.maxDepth)) continue;
      for (const link of usableLinks(page.links, args.allowed, new Set())) {
        toQueue.push(frontierRow(args.ingestId, link, depth + 1, args.keywords));
      }
    }
    const queued = await db.enqueueFrontier(toQueue);

    await db.completeFrontier(args.ingestId, urls);

    const bytes = stored.reduce((n, p) => n + p.bytes, 0);
    const failed = args.batch.length - stored.length;
    console.log(`[Crawl] stored ${stored.length} page(s), ${bytes} bytes, ${failed} failed, `
      + `queued ${queued}, indexed ${indexed}, embedded ${embedded} chunk(s)`);
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

export async function SearchCorpusActivity(
  args: { ownerId: string; query: string; ingestId?: string; projectId?: string },
): Promise<{ hits: { url: string; snippet: string }[] }> {
  const db = createDatabase();
  await db.init();
  try {
    const ends: CorpusEndpoints = await corpusEndpoints(db, args.ownerId).catch(() => ({}));
    if (ends.index || ends.vectors) {
      const hits = await searchCorpus(ends, args.query, {
        ownerId: args.ownerId,
        ingestId: args.ingestId,
        projectId: args.projectId,
      });
      if (hits.length) return { hits: hits.map((h) => ({ url: h.url, snippet: h.snippet })) };
    }

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

export async function DiscardFrontierActivity(args: { ingestId: string }): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    await db.deleteFrontier(args.ingestId);
  } finally {
    await db.close();
  }
}

export async function PurgeCorpusActivity(args: { ownerId: string; ingestId: string }): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    const ends: CorpusEndpoints = await corpusEndpoints(db, args.ownerId).catch(() => ({}));
    await purgeCorpus(ends, args.ingestId);
    await db.deleteCorpus(args.ingestId);
  } finally {
    await db.close();
  }
}

export async function NewIngestIdActivity(): Promise<{ ingestId: string }> {
  return { ingestId: uuidv4() };
}

export { buildWebTools, hostOf };
