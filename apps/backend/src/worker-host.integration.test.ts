import { hostname } from 'node:os';
import { interceptorsOf, pollersOf, REFUSING_DELETING_WORK, untilPolling, watchedRun } from '@koala/engine-core/testing/temporal';
import { describe, expect, it } from 'vitest';
import { HOST_ACTIVITIES, hostWorkerSettingsFrom, QUEUES } from './platform/index.js';
import { testIdentityKey } from './platform/testing/keys.js';
import { workerWorld } from './platform/testing/worker-world.js';
import { startHostWorker } from './worker-host.js';

const { env, rootKey, placed } = await workerWorld();

const placeFor = (role: 'root' | 'instance'): Record<string, string> => ({
  ...placed(`host-${role}`, role),
  HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '0',
  ...(role === 'root'
    ? { ROOT_IDENTITY_KEY: testIdentityKey(), PUBLIC_URL: 'http://127.0.0.1:1', INSTANCE_IMAGE_TAG: 'test' }
    : { INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: 'http://127.0.0.1:1', ROOT_PUBLIC_KEYS: rootKey, SEARXNG_URL: 'http://127.0.0.1:1', CRAWL4AI_URL: 'http://127.0.0.1:1', CRAWL4AI_API_TOKEN: 'crawl-token', QUICKWIT_URL: 'http://127.0.0.1:1', QDRANT_URL: 'http://127.0.0.1:1', QDRANT_API_KEY: 'qdrantKey40', TEI_URL: 'http://127.0.0.1:1', POD_NAME: 'luno-worker-host-7d9f-abcde' }),
});

describe('the host worker, started the way its entry starts it', () => {
  for (const role of ['root', 'instance'] as const) {
    it(`on ${role === 'root' ? 'root' : 'an instance'} polls the host queue with exactly that role's activities and the shared interceptors`, async () => {
      const { worker } = await startHostWorker(hostWorkerSettingsFrom(placeFor(role)));
      const { running, ended } = watchedRun(worker);
      const identity = role === 'instance' ? 'luno-worker-host-7d9f-abcde' : `${process.pid}@${hostname()}`;
      const polling = { namespace: env.namespace, queue: QUEUES.host, identity, ended };
      await untilPolling(env.client, polling);
      expect([...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort()).toEqual([...HOST_ACTIVITIES[role]].sort());
      expect(interceptorsOf(worker), 'the shared interceptors and the refusal of work being deleted').toEqual(REFUSING_DELETING_WORK);
      expect(worker.options.identity, 'Temporal knows an instance\'s worker by its own pod, and root\'s by its process').toBe(identity);
      expect(await pollersOf(env.client, polling), 'the worker is up, polling as itself').toContain(identity);
      worker.shutdown();
      await running;
    });
  }
});
