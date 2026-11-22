import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BlobReach } from '@koala/engine-core/payloads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceQueue, startDeviceWorker, type DeviceWorkerOptions } from './engine-worker.js';
import { IdleGate } from './idle-gate.js';
import { startTestTemporal, untilPolling, watchedRun, type TestTemporal, type TestTemporalServer } from '@koala/engine-core/testing/temporal';
import { makeCertificates, type TestCertificates } from '@koala/engine-core/testing/temporal-tls';

let server: TestTemporalServer;
let env: TestTemporal;
let rootDir: string;
let own: TestCertificates;
let other: TestCertificates;
let front: { address: string };

const blobs: BlobReach = { async put() { return undefined; }, async get() { return new Map(); } };

beforeAll(async () => {
  own = makeCertificates();
  other = makeCertificates();
  server = await startTestTemporal(own);
  env = server.env;
  front = { address: server.tlsAddress };
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-device-tls-'));
});

afterAll(async () => {
  await server.close();
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
    const { running, ended } = watchedRun(worker);
    await untilPolling(env.client, { queue: deviceQueue('tls-desk'), ended });
    worker.shutdown();
    await running;
    expect(worker.getState()).toBe('STOPPED');
  });
});
