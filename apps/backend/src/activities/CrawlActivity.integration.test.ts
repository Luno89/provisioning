import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { ApplicationFailure } from '@temporalio/common';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WORKER_DEFAULTS, activityInterceptors } from '@koala/engine-core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { hostWorkerSettingsFrom } from '../platform/index.js';
import { testKeyEnv } from '../platform/testing/keys.js';
import { testDatabaseAt } from '../platform/lib/test-database.js';
import { testDataDir } from '../platform/testing/data-dir.js';
import { dependencyStatesFor } from '../platform/wiring/dependencies.js';
import { giveHostActivities, hostClusterAccess } from './host-settings.js';
import { crawlActivities, crawlPlaceFor, DiscardFrontierActivity, NextBatchActivity, PurgeCorpusActivity, SeedFrontierActivity } from './CrawlActivity.js';
import { closedPort, startCorpusStandIn, type CorpusStandIn } from '../engine/testing/corpus-stand-in.js';
import { INDEX_ID } from '../engine/lib/corpus-client.js';
import { bundled, temporalTestEnvironment } from '../workflows/testing/temporal-test-env.js';
import type { executeIngestWorkflow } from '../workflows/IngestWorkflow.js';
import type { MongoDB } from '../platform/lib/mongo-db.js';

const PAGE = 'The retry budget is three attempts per job, and each attempt waits twice as long as the one before it, so a job that keeps failing is given up on after about a minute of trying again.';
const rootKey = Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))).toString('base64');

let standIn: CorpusStandIn;
let env: TestWorkflowEnvironment;
let db: MongoDB;
let mongoUri: string;

beforeAll(async () => {
  standIn = await startCorpusStandIn('crawl-token');
  env = await temporalTestEnvironment();
  const at = await testDatabaseAt();
  db = at.db;
  mongoUri = at.uri.replace(/\/[^/?]*(\?|$)/, `/${at.dbName}$1`);
});

afterAll(async () => {
  await env.teardown();
  await standIn.stop();
});

const settingsWith = (crawl4aiUrl: string) => hostWorkerSettingsFrom({
  NODE_ENV: 'development', ...testKeyEnv('crawl'), ROLE: 'instance', MONGO_URI: mongoUri,
  TEMPORAL_CONNECTION_ADDRESS: inject('temporalTlsAddress'), TEMPORAL_NAMESPACE: 'default', TEMPORAL_TLS_CA: inject('temporalCa'), DATA_DIR: testDataDir(),
  HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '0',
  INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: 'http://127.0.0.1:1', ROOT_PUBLIC_KEYS: rootKey,
  SEARXNG_URL: 'http://127.0.0.1:1', CRAWL4AI_URL: crawl4aiUrl, CRAWL4AI_API_TOKEN: 'crawl-token',
});

const activitiesWith = (ends: () => Promise<Record<string, unknown>>) => {
  const settings = settingsWith(standIn.base);
  const place = crawlPlaceFor(settings, hostClusterAccess(settings), dependencyStatesFor(settings));
  return crawlActivities(() => ({ ...place, endpoints: ends }));
};

const claim = (url: string) => ({ url, depth: 0 });

describe('crawling a site into a person\'s corpus', () => {
  it('reads the pages with the instance\'s own Crawl4AI at its settings\' address, and keeps them in the person\'s index, vectors and database', async () => {
    standIn.page('https://docs.example.com/', PAGE);
    const taskQueue = `ingest-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({
      ...WORKER_DEFAULTS,
      interceptors: { activity: activityInterceptors() },
      connection: env.nativeConnection,
      namespace: env.namespace ?? 'default',
      taskQueue,
      workflowBundle: await bundled(resolve(import.meta.dirname, '../workflows/IngestWorkflow.ts')),
      activities: activitiesWith(async () => standIn.endpoints),
    });

    const receipt = await worker.runUntil(env.client.workflow.execute<typeof executeIngestWorkflow>('executeIngestWorkflow', {
      taskQueue, workflowId: `ingest-${taskQueue}`,
      args: [{ ownerId: 'owner-1', url: 'https://docs.example.com/', maxDepth: 0 }],
    }));

    expect(receipt).toMatchObject({ pages: 1, failed: 0, hosts: ['docs.example.com'] });
    expect(standIn.crawled).toContainEqual(['https://docs.example.com/']);
    expect(standIn.documents(INDEX_ID).map((doc) => doc.url)).toContain('https://docs.example.com/');
    expect(standIn.points('koala-corpus').some((point) => point.ingest_id === receipt.ingestId)).toBe(true);
    expect((await db.engine.getCorpusPages({ ownerId: 'owner-1', ingestId: receipt.ingestId })).map((page) => page.url)).toEqual(['https://docs.example.com/']);
  });

  it('a crawl whose index is deployed but down is retried, not stored to the database only', async () => {
    standIn.page('https://down.example.com/', PAGE);
    const down = await closedPort();
    const { CrawlBatchActivity } = activitiesWith(async () => ({ ...standIn.endpoints, index: { base: down } }));

    const failed = await CrawlBatchActivity({ ownerId: 'owner-1', ingestId: 'down-1', batch: [claim('https://down.example.com/')], allowed: ['down.example.com'], keywords: [], maxDepth: 0 })
      .then(() => undefined, (err: unknown) => err);

    expect(failed).toBeInstanceOf(Error);
    expect(failed instanceof ApplicationFailure && failed.nonRetryable).toBe(false);
    expect(await db.engine.getCorpusPages({ ownerId: 'owner-1', ingestId: 'down-1' })).toEqual([]);
  });

  it('a person with no Quickwit, Qdrant or TEI of their own is refused once, naming them, and nothing is crawled or stored', async () => {
    const before = standIn.crawled.length;
    const { CrawlBatchActivity } = activitiesWith(async () => ({}));

    const failed = await CrawlBatchActivity({ ownerId: 'owner-1', ingestId: 'none-1', batch: [claim('https://docs.example.com/')], allowed: ['docs.example.com'], keywords: [], maxDepth: 0 })
      .then(() => undefined, (err: unknown) => err);

    expect(failed).toBeInstanceOf(ApplicationFailure);
    expect(failed).toMatchObject({ nonRetryable: true, message: 'crawling a site into your corpus needs your own Quickwit, Qdrant and TEI running, and you have no running Quickwit, Qdrant and TEI: deploy it as an app first' });
    expect(standIn.crawled.length).toBe(before);
    expect(await db.engine.getCorpusPages({ ownerId: 'owner-1', ingestId: 'none-1' })).toEqual([]);
  });

  it('purging a crawl the index refuses keeps its pages, saying Quickwit\'s answer', async () => {
    standIn.page('https://kept.example.com/', PAGE);
    const { CrawlBatchActivity, PurgeCorpusActivity } = activitiesWith(async () => standIn.endpoints);
    await CrawlBatchActivity({ ownerId: 'owner-1', ingestId: 'kept-1', batch: [claim('https://kept.example.com/')], allowed: ['kept.example.com'], keywords: [], maxDepth: 0 });
    standIn.refuse(/^POST \/api\/v1\/koala-corpus\/delete-tasks$/, 403, 'index is read-only');

    await expect(PurgeCorpusActivity({ ownerId: 'owner-1', ingestId: 'kept-1' })).rejects.toThrow('Quickwit refused: HTTP 403 index is read-only');
    expect(await db.engine.getCorpusPages({ ownerId: 'owner-1', ingestId: 'kept-1' })).toHaveLength(1);
  });
});

describe('the crawl activities the host worker registers, given the host\'s own settings', () => {
  it('seed a crawl, hand out its pages still to crawl and discard them, in the database the host\'s settings name', async () => {
    const settings = settingsWith(standIn.base);
    giveHostActivities(settings, hostClusterAccess(settings), dependencyStatesFor(settings));

    expect(await SeedFrontierActivity({ ingestId: 'host-1', seed: 'https://docs.example.com/', keywords: [] })).toEqual({ queued: 1 });
    expect(await NextBatchActivity({ ingestId: 'host-1', limit: 8 })).toEqual({ batch: [{ url: 'https://docs.example.com/', depth: 0 }], remaining: 1 });
    await DiscardFrontierActivity({ ingestId: 'host-1' });
    expect(await NextBatchActivity({ ingestId: 'host-1', limit: 8 })).toEqual({ batch: [], remaining: 0 });
  });

  it('purge a crawl of a person with no Quickwit or Qdrant of their own from the database, asking no index', async () => {
    const settings = settingsWith(standIn.base);
    giveHostActivities(settings, hostClusterAccess(settings), dependencyStatesFor(settings));
    await db.engine.saveCorpusPages([{ id: 'host-2:https://docs.example.com/', ownerId: 'owner-host', ingestId: 'host-2', url: 'https://docs.example.com/', host: 'docs.example.com', text: PAGE, bytes: PAGE.length, fetchedAt: '2026-11-18T00:00:00.000Z' }]);
    const indexed = standIn.documents(INDEX_ID).length;

    await PurgeCorpusActivity({ ownerId: 'owner-host', ingestId: 'host-2' });

    expect(await db.engine.getCorpusPages({ ownerId: 'owner-host', ingestId: 'host-2' })).toEqual([]);
    expect(standIn.documents(INDEX_ID)).toHaveLength(indexed);
  });
});
