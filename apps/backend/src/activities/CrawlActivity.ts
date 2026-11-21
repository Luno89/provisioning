import { createDatabase, failureOf, frontierRow, followsLinks, isOff, reachingDependency, reachingMemoryIndex, type Database, type DependencyReporter, type FrontierClaim, type HostWorkerSettings, type MemoryIndexReach } from '../platform/index.js';
import {
  buildWebTools, ensureIndex, indexPages, ensureCollection, embedPages,
  purgeCorpus, crawlPages, canonical, hostOf, usableLinks, toPage,
  type CorpusPage, type Crawler,
} from '../engine/index.js';
import { ApplicationFailure } from '@temporalio/common';
import { dependencyFetch } from '@koala/engine-core/http';
import { v4 as uuidv4 } from 'uuid';
import { messageOf } from './failure-reasons.js';
import { hostDependencies, hostSettings } from './host-settings.js';

export interface CrawlPlace {
  withDatabase<T>(work: (db: Database) => Promise<T>): Promise<T>;
  crawler(): Crawler;
  index(): MemoryIndexReach;
}

function asActivityFailure(err: unknown): unknown {
  if (err instanceof ApplicationFailure) return err;
  const failure = failureOf(err);
  return failure.kind === 'final' ? ApplicationFailure.nonRetryable(messageOf(err), 'CorpusRefused') : err;
}

async function failingAsActivity<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw asActivityFailure(err);
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

export interface NextBatchArgs {
  ingestId: string;
  limit: number;
}

export interface NextBatchResult {
  batch: FrontierClaim[];
  remaining: number;
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

export function crawlActivities(placed: () => CrawlPlace) {
  async function SeedFrontierActivity(args: SeedFrontierArgs): Promise<{ queued: number }> {
    return placed().withDatabase(async (db) => ({ queued: await db.engine.enqueueFrontier([frontierRow(args.ingestId, args.seed, 0, args.keywords)]) }));
  }

  async function NextBatchActivity(args: NextBatchArgs): Promise<NextBatchResult> {
    return placed().withDatabase(async (db) => {
      const batch = await db.engine.claimFrontier(args.ingestId, args.limit);
      return { batch, remaining: await db.engine.countFrontier(args.ingestId) };
    });
  }

  async function CrawlBatchActivity(args: CrawlBatchArgs): Promise<CrawlBatchResult> {
    if (!args.batch.length) return { stored: 0, bytes: 0, failed: 0, queued: 0, hosts: [] };

    const place = placed();
    return place.withDatabase((db) => failingAsActivity(async () => {
      const ends = place.index();
      const urls = args.batch.map((b) => b.url);
      const fetched = await crawlPages(place.crawler(), urls);

      const usable = fetched.filter((p) => !p.error && p.markdown.trim());
      const stored: CorpusPage[] = usable.map((p) => toPage(p, {
        id: `${args.ingestId}:${p.url}`,
        ownerId: args.ownerId,
        ingestId: args.ingestId,
        projectId: args.projectId,
      }));

      const docs = stored.map((p) => toDoc(p));
      await ensureIndex(ends.index);
      const indexed = await indexPages(ends.index, docs);
      await ensureCollection(ends.vectors);
      const embedded = await embedPages(ends, docs);

      await db.engine.saveCorpusPages(stored);

      const depthOf = new Map(args.batch.map((b) => [b.url, b.depth]));
      const toQueue = [];
      for (const page of usable) {
        const depth = depthOf.get(page.url) ?? depthOf.get(canonical(page.url) ?? '') ?? 0;
        if (!followsLinks(depth, args.maxDepth)) continue;
        for (const link of usableLinks(page.links, args.allowed, new Set())) {
          toQueue.push(frontierRow(args.ingestId, link, depth + 1, args.keywords));
        }
      }
      const queued = await db.engine.enqueueFrontier(toQueue);

      await db.engine.completeFrontier(args.ingestId, urls);

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
    }));
  }

  async function DiscardFrontierActivity(args: { ingestId: string }): Promise<void> {
    await placed().withDatabase((db) => db.engine.deleteFrontier(args.ingestId));
  }

  async function PurgeCorpusActivity(args: { ownerId: string; ingestId: string }): Promise<void> {
    const place = placed();
    await place.withDatabase((db) => failingAsActivity(async () => {
      await purgeCorpus(place.index(), args.ingestId);
      await db.engine.deleteCorpus(args.ingestId);
    }));
  }

  async function NewIngestIdActivity(): Promise<{ ingestId: string }> {
    return { ingestId: uuidv4() };
  }

  return { SeedFrontierActivity, NextBatchActivity, CrawlBatchActivity, DiscardFrontierActivity, PurgeCorpusActivity, NewIngestIdActivity };
}

export function crawlPlaceFor(settings: HostWorkerSettings, dependencies: DependencyReporter): CrawlPlace {
  return {
    withDatabase: async (work) => {
      const db = createDatabase({ mongo: settings.mongo, dataKey: settings.keys.data });
      await db.init();
      try {
        return await work(db);
      } finally {
        await db.close();
      }
    },
    crawler: () => {
      const { crawl4aiUrl, crawl4aiToken } = settings.webTools;
      if (!crawl4aiUrl || !crawl4aiToken) throw ApplicationFailure.nonRetryable('this Koala has no Crawl4AI of its own set (CRAWL4AI_URL and CRAWL4AI_API_TOKEN), so nothing can be crawled', 'NoCrawler');
      return { base: crawl4aiUrl, token: crawl4aiToken, ...reachingDependency(dependencies, 'crawl4ai', dependencyFetch) };
    },
    index: () => {
      const index = settings.memoryIndex;
      if (isOff(index)) throw ApplicationFailure.nonRetryable(`nothing can be crawled here: ${index.off}`, 'NoMemoryIndex');
      return reachingMemoryIndex(index, dependencies, dependencyFetch);
    },
  };
}

const onThisHost = (): CrawlPlace => crawlPlaceFor(hostSettings(), hostDependencies());

const onHost = crawlActivities(onThisHost);

export const SeedFrontierActivity = onHost.SeedFrontierActivity;
export const NextBatchActivity = onHost.NextBatchActivity;
export const CrawlBatchActivity = onHost.CrawlBatchActivity;
export const DiscardFrontierActivity = onHost.DiscardFrontierActivity;
export const PurgeCorpusActivity = onHost.PurgeCorpusActivity;
export const NewIngestIdActivity = onHost.NewIngestIdActivity;

export { buildWebTools, hostOf };
