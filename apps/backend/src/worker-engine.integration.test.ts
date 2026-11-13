import { generateKeyPairSync } from 'node:crypto';
import { temporal } from '@temporalio/proto';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { engineWorkerSettingsFrom, QUEUES } from './platform/index.js';
import { testIdentityKey, testKeyEnv } from './platform/testing/keys.js';
import { testDatabaseAt } from './platform/lib/test-database.js';
import { testMinioEnv } from './files/testing/real-minio.js';
import { realTemporalEnvironment } from './workflows/temporal-test-env.js';
import { createEngineWorker, engineWorkerSetup } from './worker-engine.js';
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
const away = 'http://127.0.0.1:1';

const placeFor = (role: 'root' | 'instance'): Record<string, string> => ({
  NODE_ENV: 'development', ...testKeyEnv(`engine-${role}`), ROLE: role, MONGO_URI: mongoUri,
  TEMPORAL_CONNECTION_ADDRESS: inject('temporalAddress'), TEMPORAL_NAMESPACE: env.namespace ?? 'default', TEMPORAL_TLS_CA: '/nowhere/ca.crt', DATA_DIR: testDataDir(),
  HEALTH_PORT: '0', TEMPORAL_ENGINE_METRICS_PORT: '0', PUBLIC_URL: away, TERRAFORM_STATE: 'local',
  ...(role === 'root'
    ? { ROOT_IDENTITY_KEY: testIdentityKey() }
    : {
      INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: away, ROOT_PUBLIC_KEYS: rootKey, INSTANCE_CREDENTIAL: 'cred',
      GITEA_URL: away, GITEA_REACHES_KOALA_AT: away, INFISICAL_URL: away, ...testMinioEnv(),
      KOALA_REGISTRY: '127.0.0.1:1', KOALA_REGISTRY_PUSH: '127.0.0.1:1', REGISTRY_PULL_HOST: '127.0.0.1:1',
      SEARXNG_URL: away, CRAWL4AI_URL: away, CRAWL4AI_API_TOKEN: 'crawl-token', CHECKS_API_URL: `${away}/api`,
    }),
});

describe('the engine worker, started the way its entry starts it', () => {
  it('on an instance builds its activities, polls the engine queue with them and the shared interceptors, and stops when told', async () => {
    const settings = engineWorkerSettingsFrom(placeFor('instance'));
    const { dependencies } = engineWorkerSetup(settings);
    const { worker, activities } = await createEngineWorker(settings, dependencies);
    const running = worker.run();
    const pollers = async () => (await env.client.workflowService.describeTaskQueue({
      namespace: env.namespace ?? 'default', taskQueue: { name: QUEUES.engine }, taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 100));
    const registered = [...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort();
    expect(registered).toEqual(Object.keys(activities).sort());
    expect(registered).toEqual(expect.arrayContaining(['EngineNodeActivity', 'EngineToolActivity', 'CheckRunScenarioActivity', 'StoredFilesCommitActivity']));
    expect(worker.options.interceptors.activity).toHaveLength(4);
    worker.shutdown();
    await running;
  }, 120_000);

  it('is refused by its settings on root, which runs no engine worker', () => {
    expect(() => engineWorkerSettingsFrom(placeFor('root'))).toThrow(/the engine worker runs only in an instance, and ROLE is root/);
  });
});
