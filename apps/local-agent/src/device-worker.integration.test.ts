import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { temporal } from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { BlobReach } from '@koala/engine-core/payloads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeviceActivities, deviceQueue, startDeviceWorker } from './engine-worker.js';
import { IdleGate } from './idle-gate.js';
import { makeCertificates, tlsInFrontOf, type TestCertificates } from './testing/temporal-tls.js';

let env: TestWorkflowEnvironment;
let rootDir: string;
let certificates: TestCertificates;
let front: { address: string; close(): Promise<void> };

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-device-boot-'));
  certificates = makeCertificates();
  front = await tlsInFrontOf(env.address, certificates);
});

afterAll(async () => {
  await front.close();
  await env.teardown();
  await fs.rm(rootDir, { recursive: true, force: true });
});

const kept = new Map<string, Uint8Array>();
const blobs: BlobReach = {
  async put(stored) { for (const blob of stored) kept.set(blob.id, blob.data); },
  async get(ids) { return new Map(ids.filter((id) => kept.has(id)).map((id) => [id, kept.get(id)!])); },
};

describe('the device worker, started as the machine agent starts it', () => {
  it('connects with the machine\'s token, polls its own device queue for every device activity, says it is ready and stops when told', async () => {
    const said: string[] = [];
    const worker = await startDeviceWorker({
      rootDir,
      deviceId: 'boot-desk',
      address: front.address,
      tls: { ca: certificates.ca, serverName: certificates.serverName },
      token: 'device-token',
      payloads: { ring: { current: 'device-boot-payload-key-0123456789abcdef' }, blobs },
      gate: new IdleGate(),
      onReady: (queue) => said.push(queue),
    });
    const running = worker.run();
    const pollers = async () => (await env.client.workflowService.describeTaskQueue({
      namespace: 'default',
      taskQueue: { name: deviceQueue('boot-desk') },
      taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 100));
    expect(said).toEqual(['device-boot-desk']);
    expect([...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort()).toEqual(Object.keys(createDeviceActivities({ rootDir, deviceId: 'boot-desk' })).sort());
    expect(worker.options.interceptors.activity).toHaveLength(4);
    worker.shutdown();
    await running;
    expect(worker.getState()).toBe('STOPPED');
  });
});
