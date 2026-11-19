import { temporal } from '@temporalio/proto';
import { describe, expect, it } from 'vitest';
import { HOST_ACTIVITIES, hostWorkerSettingsFrom, QUEUES } from './platform/index.js';
import { testIdentityKey } from './platform/testing/keys.js';
import { workerWorld } from './platform/testing/worker-world.js';
import { startHostWorker } from './worker-host.js';
import { runThenLetGo } from './platform/wiring/fences.js';

const { env, rootKey, live, placed } = await workerWorld();

const placeFor = (role: 'root' | 'instance'): Record<string, string> => ({
  ...placed(`host-${role}`, role),
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
      const { worker, fences } = await startHostWorker(hostWorkerSettingsFrom(placeFor(role)));
      const running = runThenLetGo(worker, fences);
      while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 100));
      expect([...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort()).toEqual([...HOST_ACTIVITIES[role]].sort());
      expect(worker.options.interceptors.activity).toHaveLength(4);
      expect((await live()).map((process) => process.name)).toContain('worker-host');
      worker.shutdown();
      await running;
      expect(await live(), 'a worker that stopped cleanly is no longer live, so a fence waits on it no more').toEqual([]);
    });
  }
});
