import { generateKeyPairSync } from 'node:crypto';
import { temporal } from '@temporalio/proto';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { clusterWorkerSettingsFrom, QUEUES } from './platform/index.js';
import { testIdentityKey, testKeyEnv } from './platform/testing/keys.js';
import { testDatabaseAt } from './platform/lib/test-database.js';
import { realTemporalEnvironment } from './workflows/testing/temporal-test-env.js';
import { startClusterWorker } from './worker-cluster.js';
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
  NODE_ENV: 'development', ...testKeyEnv(`cluster-${role}`), ROLE: role, MONGO_URI: mongoUri,
  TEMPORAL_CONNECTION_ADDRESS: inject('temporalTlsAddress'), TEMPORAL_NAMESPACE: env.namespace ?? 'default', TEMPORAL_TLS_CA: inject('temporalCa'), DATA_DIR: testDataDir(),
  HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '0', TERRAFORM_STATE: 'local', REGISTRY_PULL_HOST: '127.0.0.1:1',
  GITEA_URL: 'http://127.0.0.1:1', GITEA_REACHES_KOALA_AT: 'http://127.0.0.1:1', INFISICAL_URL: 'http://127.0.0.1:1',
  ...(role === 'root' ? { ROOT_IDENTITY_KEY: testIdentityKey() } : { INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: 'http://127.0.0.1:1', ROOT_PUBLIC_KEYS: rootKey }),
});

const EXPECTED = ['CheckWorkloadActivity', 'DeployAppActivity', 'DestroyAppActivity', 'DownloadModelActivity', 'ResizeDiskActivity', 'RunPipelineActivity', 'SyncConfigActivity', 'VerifyGpuRuntimeActivity'];

const live = async () => {
  const client = mongoClientFor(mongoUri);
  try {
    return await new MongoPlatformStore(() => client.db()).processesSeenSince(new Date(Date.now() - 60_000).toISOString());
  } finally {
    await client.close();
  }
};

describe('the cluster worker, started the way its entry starts it', () => {
  it('on an instance polls the cluster queue with every cluster activity and the shared interceptors', async () => {
    const { worker, fences } = await startClusterWorker(clusterWorkerSettingsFrom(placeFor('instance')));
    const running = runThenLetGo(worker, fences);
    const pollers = async () => (await env.client.workflowService.describeTaskQueue({
      namespace: env.namespace ?? 'default', taskQueue: { name: QUEUES.cluster }, taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 100));
    expect([...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort()).toEqual(EXPECTED);
    expect(worker.options.interceptors.activity).toHaveLength(4);
    expect((await live()).map((process) => process.name)).toEqual(['worker-cluster']);
    worker.shutdown();
    await running;
    expect(await live(), 'a worker that stopped cleanly is no longer live, so a fence waits on it no more').toEqual([]);
  });

  it('is refused by its settings on root, which runs no cluster worker', () => {
    expect(() => clusterWorkerSettingsFrom(placeFor('root'))).toThrow(/the cluster worker runs only in an instance, whose apps it deploys, and ROLE is root/);
  });
});
