import { temporal } from '@temporalio/proto';
import type { BlobReach } from '@koala/engine-core/payloads';
import { describe, expect, it } from 'vitest';
import { createDeviceActivities, deviceQueue, startDeviceWorker } from './engine-worker.js';
import { IdleGate } from './idle-gate.js';
import { temporalBehindTls } from './testing/temporal-world.js';

const world = temporalBehindTls('koala-device-boot-');

const kept = new Map<string, Uint8Array>();
const blobs: BlobReach = {
  async put(stored) { for (const blob of stored) kept.set(blob.id, blob.data); },
  async get(ids) { return new Map(ids.filter((id) => kept.has(id)).map((id) => [id, kept.get(id)!])); },
};

describe('the device worker, started as the machine agent starts it', () => {
  it('connects with the machine\'s token, polls its own device queue for every device activity, says it is ready and stops when told', async () => {
    const said: string[] = [];
    const worker = await startDeviceWorker({
      rootDir: world.rootDir,
      deviceId: 'boot-desk',
      address: world.front.address,
      tls: { ca: world.certificates.ca, serverName: world.certificates.serverName },
      token: 'device-token',
      payloads: { ring: { current: 'device-boot-payload-key-0123456789abcdef' }, blobs },
      gate: new IdleGate(),
      onReady: (queue) => said.push(queue),
    });
    const running = worker.run();
    const pollers = async () => (await world.env.client.workflowService.describeTaskQueue({
      namespace: 'default',
      taskQueue: { name: deviceQueue('boot-desk') },
      taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 100));
    expect(said).toEqual(['device-boot-desk']);
    expect([...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort()).toEqual(Object.keys(createDeviceActivities({ rootDir: world.rootDir, deviceId: 'boot-desk' })).sort());
    expect(worker.options.interceptors.activity).toHaveLength(4);
    worker.shutdown();
    await running;
    expect(worker.getState()).toBe('STOPPED');
  });
});
