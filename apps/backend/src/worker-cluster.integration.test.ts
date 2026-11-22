import { pollersOf, untilPolling, watchedRun } from '@koala/engine-core/testing/temporal';
import { describe, expect, it } from 'vitest';
import { clusterWorkerSettingsFrom, QUEUES } from './platform/index.js';
import { testIdentityKey } from './platform/testing/keys.js';
import { workerWorld } from './platform/testing/worker-world.js';
import { startClusterWorker } from './worker-cluster.js';

const { env, rootKey, placed } = await workerWorld();

const placeFor = (role: 'root' | 'instance'): Record<string, string> => ({
  ...placed(`cluster-${role}`, role),
  HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '0', TERRAFORM_STATE: 'local', REGISTRY_PULL_HOST: '127.0.0.1:1',
  GITEA_URL: 'http://127.0.0.1:1', GITEA_REACHES_KOALA_AT: 'http://127.0.0.1:1', INFISICAL_URL: 'http://127.0.0.1:1',
  ...(role === 'root' ? { ROOT_IDENTITY_KEY: testIdentityKey() } : { INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: 'http://127.0.0.1:1', ROOT_PUBLIC_KEYS: rootKey, POD_NAMESPACE: 'nowrinkles', CRAWL4AI_API_TOKEN: 'crawlToken40', QDRANT_API_KEY: 'qdrantKey40', KOALA_RELEASE_REVISION: '1', INSTANCE_CLIENT_KEY: testIdentityKey(), INSTANCE_REGISTRATION_TOKEN: 'code', POD_NAME: 'luno-worker-cluster-7d9f-abcde' }),
});

const EXPECTED = ['AwaitProjectWorkActivity', 'CheckWorkloadActivity', 'DeployAppActivity', 'DestroyAppActivity', 'DownloadModelActivity', 'ProvisionPieceActivity', 'ResizeDiskActivity', 'RestartWorkerActivity', 'RunPipelineActivity', 'SyncConfigActivity', 'VerifyGpuRuntimeActivity'];

describe('the cluster worker, started the way its entry starts it', () => {
  it('on an instance polls the cluster queue with every cluster activity, the shared interceptors and the refusal of work being deleted', async () => {
    const { worker } = await startClusterWorker(clusterWorkerSettingsFrom(placeFor('instance')));
    const { running, ended } = watchedRun(worker);
    const polling = { namespace: env.namespace, queue: QUEUES.cluster, identity: 'luno-worker-cluster-7d9f-abcde', ended };
    await untilPolling(env.client, polling);
    expect([...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort()).toEqual(EXPECTED);
    expect(worker.options.interceptors.activity).toHaveLength(6);
    expect(worker.options.identity, 'Temporal knows the worker by its own pod').toBe('luno-worker-cluster-7d9f-abcde');
    expect(await pollersOf(env.client, polling), 'the worker is up, polling as its pod').toContain('luno-worker-cluster-7d9f-abcde');
    worker.shutdown();
    await running;
  });

  it('is refused by its settings on root, which runs no cluster worker', () => {
    expect(() => clusterWorkerSettingsFrom(placeFor('root'))).toThrow(/the cluster worker runs only in an instance, whose apps it deploys, and ROLE is root/);
  });
});
