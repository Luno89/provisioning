import { generateKeyPairSync } from 'node:crypto';
import { temporal } from '@temporalio/proto';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { HOST_ACTIVITIES, hostWorkerSettingsFrom, QUEUES } from './platform/index.js';
import { testIdentityKey, testKeyEnv } from './platform/testing/keys.js';
import { testDatabaseAt } from './platform/lib/test-database.js';
import { realTemporalEnvironment } from './workflows/temporal-test-env.js';
import { startHostWorker } from './worker-host.js';

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
  TEMPORAL_CONNECTION_ADDRESS: inject('temporalAddress'), TEMPORAL_NAMESPACE: env.namespace ?? 'default', TEMPORAL_TLS_CA: '/nowhere/ca.crt',
  HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '0',
  ...(role === 'root'
    ? { ROOT_IDENTITY_KEY: testIdentityKey(), PUBLIC_URL: 'http://127.0.0.1:1', INSTANCE_IMAGE_TAG: 'test' }
    : { INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: 'http://127.0.0.1:1', ROOT_PUBLIC_KEYS: rootKey, SEARXNG_URL: 'http://127.0.0.1:1', CRAWL4AI_URL: 'http://127.0.0.1:1', CRAWL4AI_API_TOKEN: 'crawl-token' }),
});

const pollers = async () => (await env.client.workflowService.describeTaskQueue({
  namespace: env.namespace ?? 'default',
  taskQueue: { name: QUEUES.host },
  taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
})).pollers ?? [];

describe('the host worker, started the way its entry starts it', () => {
  for (const role of ['root', 'instance'] as const) {
    it(`on ${role === 'root' ? 'root' : 'an instance'} polls the host queue with exactly that role's activities and the shared interceptors`, async () => {
      const { worker } = await startHostWorker(hostWorkerSettingsFrom(placeFor(role)));
      const running = worker.run();
      while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 100));
      expect([...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort()).toEqual([...HOST_ACTIVITIES[role]].sort());
      expect(worker.options.interceptors.activity).toHaveLength(3);
      worker.shutdown();
      await running;
    }, 60_000);
  }
});
