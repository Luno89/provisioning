import { temporal } from '@temporalio/proto';
import { describe, expect, inject, it } from 'vitest';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { testMinioEnv } from './files/testing/real-minio.js';
import { QUEUES } from './platform/index.js';
import { workerWorld } from './platform/testing/worker-world.js';
import { startRole } from './platform/testing/roles-on-loopback.js';
import { testKeyEnv, testIdentityKey } from './platform/testing/keys.js';

const { env, mongoUri, rootKey } = await workerWorld();
const away = 'http://127.0.0.1:1';
const POD = 'luno-worker-7d9f-abcde';

const instance = async (): Promise<Record<string, string>> => ({
  NODE_ENV: 'development', ...testKeyEnv('worker-stops'), ROLE: 'instance', MONGO_URI: mongoUri,
  TEMPORAL_CONNECTION_ADDRESS: inject('temporalTlsAddress'), TEMPORAL_NAMESPACE: env.namespace ?? 'default', TEMPORAL_TLS_CA: inject('temporalCa'),
  TEMPORAL_METRICS_PORT: String(await portToHandOn()), TEMPORAL_ENGINE_METRICS_PORT: String(await portToHandOn()), TERRAFORM_STATE: 'local',
  INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', INSTANCE_MACHINE_ID: 'desk', ROOT_URL: away, ROOT_PUBLIC_KEYS: rootKey, INSTANCE_CLIENT_KEY: testIdentityKey(), INSTANCE_REGISTRATION_TOKEN: 'code', KOALA_RELEASE_REVISION: '1', POD_NAME: POD,
  GITEA_URL: away, GITEA_REACHES_KOALA_AT: away, INFISICAL_URL: away, ...testMinioEnv(),
  KOALA_REGISTRY: '127.0.0.1:1', KOALA_REGISTRY_PUSH: '127.0.0.1:1', REGISTRY_PULL_HOST: '127.0.0.1:1',
  SEARXNG_URL: away, CRAWL4AI_URL: away, CRAWL4AI_API_TOKEN: 'crawlToken40', QDRANT_API_KEY: 'qdrantKey40', QUICKWIT_URL: away, QDRANT_URL: away, TEI_URL: away, CHECKS_API_URL: `${away}/api`, POD_NAMESPACE: 'nowrinkles',
});

const pollersOn = async (queue: string): Promise<string[]> => ((await env.client.workflowService.describeTaskQueue({
  namespace: env.namespace ?? 'default', taskQueue: { name: queue }, taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
})).pollers ?? []).map((poller) => poller.identity ?? '');

describe('each worker, started as its own program and stopped as a pod is', () => {
  for (const [name, entry, queue] of [['worker-host', 'src/worker-host.ts', QUEUES.host], ['worker-cluster', 'src/worker-cluster.ts', QUEUES.cluster], ['worker-engine', 'src/worker-engine.ts', QUEUES.engine]] as const) {
    it(`${name} polls its queue as its pod while it runs, and stops answering once it has stopped cleanly`, async () => {
      const worker = await startRole(name, await instance(), undefined, { entry });
      try {
        while (!(await pollersOn(queue)).includes(POD)) await new Promise((done) => setTimeout(done, 100));
        expect(await pollersOn(queue)).toContain(POD);
        await worker.stop();
        await expect(fetch(`${worker.url}/healthz`), worker.logs()).rejects.toThrow();
      } finally {
        await worker.close();
      }
    });
  }
});
