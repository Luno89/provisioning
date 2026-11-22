import { EVERY_ACTIVITY, interceptorsOf, untilPolling, watchedRun } from '@koala/engine-core/testing/temporal';
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
    const { running, ended } = watchedRun(worker);
    await untilPolling(world.env.client, { queue: deviceQueue('boot-desk'), ended });
    expect(said).toEqual(['device-boot-desk']);
    expect([...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort()).toEqual(Object.keys(createDeviceActivities({ rootDir: world.rootDir, deviceId: 'boot-desk' })).sort());
    expect(interceptorsOf(worker), 'each activity heartbeats, is traced, carries whose work it is, has its programs killed when cancelled and its failure classified; a machine reads no deleting marks').toEqual(EVERY_ACTIVITY);
    worker.shutdown();
    await running;
    expect(worker.getState()).toBe('STOPPED');
  });
});
