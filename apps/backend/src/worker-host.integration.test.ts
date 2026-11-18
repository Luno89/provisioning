import { generateKeyPairSync } from 'node:crypto';
import { temporal } from '@temporalio/proto';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { HOST_ACTIVITIES, hostWorkerSettingsFrom, QUEUES } from './platform/index.js';
import { testIdentityKey, testKeyEnv } from './platform/testing/keys.js';
import { testDatabaseAt } from './platform/lib/test-database.js';
import { realTemporalEnvironment } from './workflows/temporal-test-env.js';
import { startHostWorker } from './worker-host.js';
import { runThenLetGo } from './platform/wiring/fences.js';
import { mongoClientFor } from './platform/lib/collection.js';
import { MongoPlatformStore } from './platform/store.js';
import { testDataDir } from './platform/testing/data-dir.js';

let env: TestWorkflowEnvironment;
let mongoUri: string;

beforeAll(async () => {
  env = await realTemporalEnvironment();
  const { uri, dbName } = await testDatabaseAt();
  mongoUri = `${uri.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`)}`;
});
afterAll(async () => { await env.teardown(); });

const rootKey = Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))).toString('base64');

const placeFor = (role: 'root' | 'instance'): Record<string, string> => ({
  NODE_ENV: 'development', ...testKeyEnv(`host-${role}`), ROLE: role, MONGO_URI: mongoUri,
  TEMPORAL_CONNECTION_ADDRESS: inject('temporalTlsAddress'), TEMPORAL_NAMESPACE: env.namespace ?? 'default', TEMPORAL_TLS_CA: inject('temporalCa'), DATA_DIR: testDataDir(),
  HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '0',
  ...(role === 'root'
    ? { ROOT_IDENTITY_KEY: testIdentityKey(), PUBLIC_URL: 'http://127.0.0.1:1', INSTANCE_IMAGE_TAG: 'test' }
    : { INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: 'http://127.0.0.1:1', ROOT_PUBLIC_KEYS: rootKey, SEARXNG_URL: 'http://127.0.0.1:1', CRAWL4AI_URL: 'http://127.0.0.1:1', CRAWL4AI_API_TOKEN: 'crawl-token' }),
});

const live = async () => {
  const client = mongoClientFor(mongoUri);
  try {
    return await new MongoPlatformStore(() => client.db()).processesSeenSince(new Date(Date.now() - 60_000).toISOString());
  } finally {
    await client.close();
  }
};

const pollers = async () => (await env.client.workflowService.describeTaskQueue({
  namespace: env.namespace ?? 'default',
  taskQueue: { name: QUEUES.host },
  taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
})).pollers ?? [];

describe('the host worker, started the way its entry starts it', () => {
  for (const role of ['root', 'instance'] as const) {
    it(`on ${role === 'root' ? 'root' : 'an instance'} polls the host queue with exactly that role's activities and the shared interceptors`, async () => {
      const { worker, fences } = await startHostWorker(hostWorkerSettingsFrom(placeFor(role)));
      const running = runThenLetGo(worker, fences);
      while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 100));
      expect([...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort()).toEqual([...HOST_ACTIVITIES[role]].sort());
      expect(worker.options.interceptors.activity).toHaveLength(4);
      expect((await live()).map((process) => process.name)).toContain('worker-host');
      worker.shutdown();
      await running;
      expect(await live(), 'a worker that stopped cleanly is no longer live, so a fence waits on it no more').toEqual([]);
    }, 60_000);
  }
});
