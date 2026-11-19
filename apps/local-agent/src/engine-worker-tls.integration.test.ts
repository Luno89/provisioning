import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { temporal } from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { BlobReach } from '@koala/engine-core/payloads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceQueue, startDeviceWorker, type DeviceWorkerOptions } from './engine-worker.js';
import { IdleGate } from './idle-gate.js';
import { makeCertificates, tlsInFrontOf, type TestCertificates } from './testing/temporal-tls.js';

let env: TestWorkflowEnvironment;
let rootDir: string;
let own: TestCertificates;
let other: TestCertificates;
let front: { address: string; close(): Promise<void> };

const blobs: BlobReach = { async put() { return undefined; }, async get() { return new Map(); } };

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-device-tls-'));
  own = makeCertificates();
  other = makeCertificates();
  front = await tlsInFrontOf(env.address, own);
});

afterAll(async () => {
  await front.close();
  await env.teardown();
  await fs.rm(rootDir, { recursive: true, force: true });
});

const options = (deviceId: string, address: string, certificates: TestCertificates): DeviceWorkerOptions => ({
  rootDir,
  deviceId,
  address,
  tls: { ca: certificates.ca, serverName: own.serverName },
  token: 'device-token',
  payloads: { ring: { current: 'device-tls-payload-key-0123456789abcdef' }, blobs },
  gate: new IdleGate(),
});

describe('how the machine reaches Temporal', () => {
  it('refuses a Temporal that answers in plaintext', async () => {
    await expect(startDeviceWorker(options('plain-desk', env.address, own))).rejects.toThrow(/tls|handshake|certificate|transport/i);
  });

  it('refuses a Temporal whose certificate is not signed by the install\'s own certificate authority', async () => {
    await expect(startDeviceWorker(options('stranger-desk', front.address, other))).rejects.toThrow(/certificate|unknown ?issuer|invalid peer|tls|handshake/i);
  });

  it('takes work over TLS from a Temporal its install\'s certificate authority signed', async () => {
    const worker = await startDeviceWorker(options('tls-desk', front.address, own));
    const running = worker.run();
    const pollers = async () => (await env.client.workflowService.describeTaskQueue({
      namespace: 'default',
      taskQueue: { name: deviceQueue('tls-desk') },
      taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 100));
    worker.shutdown();
    await running;
    expect(worker.getState()).toBe('STOPPED');
  });
});
