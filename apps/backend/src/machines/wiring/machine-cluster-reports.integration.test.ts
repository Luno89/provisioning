import { testKeys } from '../../platform/testing/keys.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { clusterOnConnect, K3S_MARKER, type ClusterHost } from '../../../../local-agent/src/machine-cluster.js';
import { machineCapacity } from '../../../../local-agent/src/machine-capacity.js';
import { machineGpus, NVIDIA_CDI_HOOK, NVIDIA_RUNTIME } from '../../../../local-agent/src/machine-gpus.js';
import { emptiedEachTime, testPayloadBlobs } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { issueWorkToken } from '../lib/work-tokens.js';
import { MachineService } from '../services/MachineService.js';
import { MachineClusters } from '../services/MachineClusters.js';
import { wireSockets, type SocketsWiringDeps } from './sockets.js';

const fresh = await emptiedEachTime();
const root = identityKeysFrom(generateIdentityKey());
const workTokens = { keys: trustedKeys([publicKeyPem(root.publicKey)]), audience: 'inst-1' };
const TOKEN = issueWorkToken(root, { machineId: 'desk', ownerId: 'owner-1', audience: 'inst-1' });
const keys = testKeys('machine-cluster-reports-secret');

let db: MongoDB;
let server: http.Server;
let io: SocketServer;
let url = '';
const clients: ClientSocket[] = [];

const machineWith = (installed: boolean): MockProxy<ClusterHost> => {
  const host = mock<ClusterHost>();
  host.exists.mockImplementation(async (path) => installed && path === K3S_MARKER);
  host.isWanted.mockResolvedValue(false);
  host.run.mockResolvedValue('inactive\n');
  return host;
};

async function reports(host: ClusterHost, withGpus = false): Promise<void> {
  const socket = connect(`${url}/agent`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); });
  const state = await clusterOnConnect(host, () => undefined);
  if (!withGpus) {
    socket.emit('machine:cluster', { state });
    return;
  }
  const gpus = await machineGpus(host);
  socket.emit('machine:cluster', { state, gpus: gpus.gpus, problems: gpus.problems, capacity: machineCapacity({ cpus: () => 16, totalMemory: () => 64 * 1024 ** 3 }) });
}

const withTwoNvidiaCards = (host: MockProxy<ClusterHost>): ClusterHost => {
  host.run.mockImplementation(async (file) => (file === 'nvidia-smi' ? 'NVIDIA GeForce RTX 3090, 24576\nNVIDIA GeForce RTX 3090, 24576\n' : 'inactive\n'));
  host.exists.mockImplementation(async (path) => path === K3S_MARKER || path === NVIDIA_CDI_HOOK || path === NVIDIA_RUNTIME);
  return host;
};

async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
}

const desk = async () => (await db.infrastructure.getClusters()).find((cluster) => cluster.id === 'machine-desk');

beforeEach(async () => {
  db = await fresh();
  const machines = new MachineService({
    store: db.machines,
    devices: { status: () => ({ online: true }) } as never,
    accounts: { createJoinCode: async () => { throw new Error('not used'); }, remove: async () => false },
    projects: { register: async () => { throw new Error('not used'); } },
  });
  await db.machines.saveLocalAgentDevice({ id: 'desk', ownerId: 'owner-1', name: 'desk', rootDir: '/home/person/koala', meshIp: '100.64.0.7', createdAt: new Date().toISOString() });
  server = http.createServer();
  io = new SocketServer(server);
  wireSockets({
    io, db, role: { role: 'instance', instance: { id: 'inst-1', ownerId: 'owner-1', rootUrl: 'http://root.test' } }, signsEveryoneIn: false, payloadBlobs: testPayloadBlobs().blobs, payloadKey: keys.payload, dataKey: keys.data,
    auth: { sessionFromCookie: async () => undefined, securedFor: () => false, principalFor: () => undefined } as unknown as SocketsWiringDeps['auth'],
    sessionSockets: { track: () => undefined, forget: () => undefined },
    machines, workTokens, clusters: {} as never, apps: {} as never,
    telemetry: { relay: async () => ({ ok: true }) } as never,
    machineClusters: new MachineClusters({ store: db.infrastructure, dataKey: keys.data }),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await io.close();
  await new Promise<void>((done) => server.close(() => done()));
});

describe('a machine telling Koala about its own cluster', () => {
  it('a machine whose k3s Koala installed shows its cluster, stopped, on its mesh address', async () => {
    await reports(machineWith(true));
    expect(await until(desk)).toMatchObject({ provider: 'machine', status: 'stopped', machineId: 'desk', ownerId: 'owner-1', meshIp: '100.64.0.7' });
  }, 30_000);

  it('a machine reporting its GPUs and its size again keeps them on its cluster, read by the agent\'s own readers', async () => {
    await reports(machineWith(true));
    await until(desk);
    await reports(withTwoNvidiaCards(machineWith(true)), true);
    const reported = await until(async () => ((await desk())?.gpus ? desk() : undefined));
    expect(reported).toMatchObject({ gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true }], gpuProblems: [] });
    expect(reported?.capacity).toEqual({ cpuCores: 16, ramGb: 64, gpuCount: 2, gpuVendor: 'nvidia' });
  }, 30_000);

  it('a machine whose k3s is gone takes its cluster with it once no app is on it', async () => {
    await reports(machineWith(true));
    await until(desk);
    await reports(machineWith(false));
    await until(async () => ((await desk()) ? undefined : true));
    expect(await desk()).toBeUndefined();
  }, 30_000);
});
