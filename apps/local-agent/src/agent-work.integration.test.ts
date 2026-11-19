import fs from 'fs/promises';
import { createServer } from 'node:http';
import os from 'os';
import path from 'path';
import { temporal } from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWork, type AgentPlace } from './agent-work.js';
import { deviceQueue, startDeviceWorker } from './engine-worker.js';
import type { ClusterHost } from './machine-cluster.js';
import { makeCertificates, tlsInFrontOf, type TestCertificates } from './testing/temporal-tls.js';

let env: TestWorkflowEnvironment;
let rootDir: string;
let certificates: TestCertificates;
let front: { address: string; close(): Promise<void> };

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-agent-work-'));
  certificates = makeCertificates();
  front = await tlsInFrontOf(env.address, certificates);
});

afterAll(async () => {
  await front.close();
  await env.teardown();
  await fs.rm(rootDir, { recursive: true, force: true });
});

const noKoalaK3s: ClusterHost = {
  platform: 'linux',
  run: async (file) => {
    if (file === 'nvidia-smi') return 'NVIDIA GeForce RTX 3090, 24576\n';
    if (file === 'lspci') return 'Slot:\t01:00.0\nClass:\tVGA compatible controller [0300]\nVendor:\tNVIDIA Corporation [10de]\nDevice:\tGA102 [GeForce RTX 3090] [2204]\nDriver:\tnvidia\n';
    throw Object.assign(new Error(`spawn ${file} ENOENT: this computer has no ${file}`), { code: 'ENOENT' });
  },
  exists: async () => false,
  read: async () => { throw new Error('nothing to read'); },
  list: async () => [],
  wanted: async () => undefined,
  isWanted: async () => false,
  holdKoala: async () => undefined,
  holdsKoala: async () => false,
  heldKoala: async () => undefined,
  letKoalaGo: async () => undefined,
  meshIp: async () => undefined,
  now: () => Date.now(),
  pause: (ms) => new Promise((done) => setTimeout(done, ms)),
};

describe('the machine agent starting its work for its Koala', () => {
  it('connects to its Koala with its work token, reports its agents, its cluster and its GPUs, and starts its device worker, which polls the machine\'s queue', async () => {
    const http = createServer();
    const koala = new Server(http);
    const heard: Record<string, unknown> = {};
    koala.of('/agent').on('connection', (socket) => {
      heard.token = (socket.handshake.auth as { token?: string }).token;
      socket.on('agents:manual', (_payload: unknown, ack: (answer: unknown) => void) => ack({ agents: [] }));
      socket.on('agents:found', (found: unknown) => { heard.agents = found; });
      socket.on('machine:cluster', (state: unknown) => { heard.cluster = state; });
      socket.on('machine:payloads', (_payload: unknown, ack: (answer: unknown) => void) => {
        ack({ ring: { current: 'agent-work-payload-key-0123456789abcdef' }, temporal: { address: front.address, namespace: 'default', ca: certificates.ca, serverName: certificates.serverName } });
      });
    });
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
    const { port } = http.address() as { port: number };
    const stops: Array<() => void> = [];
    const place: AgentPlace = {
      agentDir: rootDir,
      ownBundle: 'bundle-sha',
      service: undefined,
      cluster: noKoalaK3s,
      discovery: () => ({ which: async () => undefined, exists: async () => false, probe: async () => { throw new Error('nothing to probe'); } }),
      agentsNotSetUp: async () => undefined,
      startDeviceWorker,
      onStop: (stop) => { stops.push(stop); },
      exit: () => undefined,
    };

    const work = startWork(place, { rootUrl: 'http://127.0.0.1:1', token: 'device', rootDir, deviceId: 'work-desk' }, `http://127.0.0.1:${port}`, 'work-token', () => undefined, () => undefined);
    expect(work.url).toBe(`http://127.0.0.1:${port}`);

    const pollers = async () => (await env.client.workflowService.describeTaskQueue({
      namespace: 'default', taskQueue: { name: deviceQueue('work-desk') }, taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0 || heard.agents === undefined || heard.cluster === undefined) await new Promise((done) => setTimeout(done, 100));
    expect(heard).toMatchObject({ token: 'work-token', agents: { agents: [] }, cluster: { state: 'absent', gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 1, runtime: false }], problems: [], withoutDriver: [] } });
    expect(stops).toHaveLength(1);
    await new Promise<void>((done) => { void koala.close(() => done()); });
  });
});
