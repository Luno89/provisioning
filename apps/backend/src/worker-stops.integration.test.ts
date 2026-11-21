import { describe, expect, inject, it } from 'vitest';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { testMinioEnv } from './files/testing/real-minio.js';
import { workerWorld } from './platform/testing/worker-world.js';
import { startRole } from './platform/testing/roles-on-loopback.js';
import { testKeyEnv, testIdentityKey } from './platform/testing/keys.js';

const { env, mongoUri, rootKey, live } = await workerWorld();
const away = 'http://127.0.0.1:1';

const instance = async (): Promise<Record<string, string>> => ({
  NODE_ENV: 'development', ...testKeyEnv('worker-stops'), ROLE: 'instance', MONGO_URI: mongoUri,
  TEMPORAL_CONNECTION_ADDRESS: inject('temporalTlsAddress'), TEMPORAL_NAMESPACE: env.namespace ?? 'default', TEMPORAL_TLS_CA: inject('temporalCa'),
  TEMPORAL_METRICS_PORT: String(await portToHandOn()), TEMPORAL_ENGINE_METRICS_PORT: String(await portToHandOn()), TERRAFORM_STATE: 'local',
  INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', INSTANCE_MACHINE_ID: 'desk', ROOT_URL: away, ROOT_PUBLIC_KEYS: rootKey, INSTANCE_CLIENT_KEY: testIdentityKey(), INSTANCE_REGISTRATION_TOKEN: 'code', KOALA_RELEASE_REVISION: '1', POD_NAME: 'luno-worker-7d9f-abcde',
  GITEA_URL: away, GITEA_REACHES_KOALA_AT: away, INFISICAL_URL: away, ...testMinioEnv(),
  KOALA_REGISTRY: '127.0.0.1:1', KOALA_REGISTRY_PUSH: '127.0.0.1:1', REGISTRY_PULL_HOST: '127.0.0.1:1',
  SEARXNG_URL: away, CRAWL4AI_URL: away, CRAWL4AI_API_TOKEN: 'crawlToken40', CHECKS_API_URL: `${away}/api`, POD_NAMESPACE: 'nowrinkles',
});

const liveNames = async (): Promise<string[]> => (await live()).map((process) => process.name);

describe('each worker, started as its own program and stopped as a pod is', () => {
  for (const [name, entry] of [['worker-host', 'src/worker-host.ts'], ['worker-cluster', 'src/worker-cluster.ts'], ['worker-engine', 'src/worker-engine.ts']] as const) {
    it(`${name} is live while it runs and no longer live once it has stopped cleanly`, async () => {
      const worker = await startRole(name, await instance(), undefined, { entry });
      try {
        expect(await liveNames()).toContain(name);
        await worker.stop();
        expect(await liveNames(), worker.logs()).not.toContain(name);
      } finally {
        await worker.close();
      }
    });
  }
});
